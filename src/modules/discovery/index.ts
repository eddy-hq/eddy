import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';

interface TopicRow {
  id: string;
  label: string;
  category: string | null;
}

// Fetch up to `limit` video titles from a YouTube RSS feed.
async function fetchRecentTitles(channelId: string, limit = 5): Promise<string[]> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let xml: string;
  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return [];
    xml = await resp.text();
  } catch {
    return [];
  }

  const titles: string[] = [];
  const re = /<title>([^<]+)<\/title>/g;
  re.exec(xml); // skip the feed-level <title>
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && titles.length < limit) {
    const decoded = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    titles.push(decoded.trim());
  }
  return titles;
}

// Infer 1-2 topic IDs for a newly followed channel and store in channel_topic_links.
// Fire-and-forget: called after follow, does not block the response.
export async function inferChannelTopics(channelId: string, channelName: string): Promise<void> {
  const existing = db.prepare(
    'SELECT 1 FROM channel_topic_links WHERE channel_id = ? LIMIT 1'
  ).get(channelId);
  if (existing) return;

  const topics = db.prepare(
    'SELECT id, label, category FROM topics ORDER BY category, label'
  ).all() as TopicRow[];
  if (topics.length === 0) return;

  const recentTitles = await fetchRecentTitles(channelId);
  const titlesText = recentTitles.length > 0
    ? `\nRecent video titles: ${recentTitles.join('; ')}`
    : '';

  const topicList = topics
    .map((t) => `${t.id}: ${t.label}${t.category ? ` (${t.category})` : ''}`)
    .join('\n');

  const prompt = `You are categorising a YouTube channel for a content recommendation system.

Channel name: "${channelName}"${titlesText}

Available topics:
${topicList}

Select 1 or 2 topic IDs from the list above that best describe the content of this channel. Return a JSON array of IDs only, for example ["minecraft"] or ["programming","electronics"]. If no topic fits well, return []. No explanation.`;

  let raw: string;
  try {
    raw = await ollamaGenerate(prompt);
  } catch (err) {
    logger.warn({ err, channelId }, 'Channel topic inference: Gemma call failed');
    return;
  }

  let topicIds: string[];
  try {
    const match = /\[.*?]/.exec(raw.trim());
    if (!match) return;
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return;
    topicIds = (parsed as unknown[])
      .filter((v): v is string => typeof v === 'string')
      .slice(0, 2);
  } catch {
    logger.warn({ channelId, raw }, 'Channel topic inference: could not parse response');
    return;
  }

  const validIds = new Set(topics.map((t) => t.id));
  const now = new Date().toISOString();
  const inserted: string[] = [];

  for (const topicId of topicIds) {
    if (!validIds.has(topicId)) continue;
    db.prepare(`
      INSERT OR IGNORE INTO channel_topic_links (channel_id, topic_id, confidence, inferred_at)
      VALUES (?, ?, 1.0, ?)
    `).run(channelId, topicId, now);
    inserted.push(topicId);
  }

  if (inserted.length > 0) {
    logger.info({ channelId, topicIds: inserted }, 'Channel topic inference stored');
  }
}
