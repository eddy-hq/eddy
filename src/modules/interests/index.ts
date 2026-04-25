import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';

export { interestsRouter } from './router';
export { normalizeUserAddedInterest, type NormalizedUserInterest } from './normalize';

interface InterestRow {
  id: string;
  label: string;
  category: string | null;
}

// ── Channel interest inference ────────────────────────────────────────────────

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
  re.exec(xml);
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && titles.length < limit) {
    const decoded = m[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    titles.push(decoded.trim());
  }
  return titles;
}

export async function inferChannelInterests(channelId: string, channelName: string): Promise<void> {
  const existing = db.prepare(
    'SELECT 1 FROM channel_interest_links WHERE channel_id = ? LIMIT 1'
  ).get(channelId);
  if (existing) return;

  const interests = db.prepare(
    'SELECT id, label, category FROM interests ORDER BY category, label'
  ).all() as InterestRow[];
  if (interests.length === 0) return;

  const recentTitles = await fetchRecentTitles(channelId);
  const titlesText = recentTitles.length > 0
    ? `\nRecent video titles: ${recentTitles.join('; ')}`
    : '';

  const interestList = interests
    .map((t) => `${t.id}: ${t.label}${t.category ? ` (${t.category})` : ''}`)
    .join('\n');

  const prompt = `You are categorising a YouTube channel for a content recommendation system.

Channel name: "${channelName}"${titlesText}

Available interests:
${interestList}

Select 1 or 2 interest IDs from the list above that best describe the content of this channel. Return a JSON array of IDs only, for example ["minecraft"] or ["programming","electronics"]. If no interest fits well, return []. No explanation.`;

  let raw: string;
  try {
    raw = await ollamaGenerate(prompt);
  } catch (err) {
    logger.warn({ err, channelId }, 'Channel interest inference: Gemma call failed');
    return;
  }

  let interestIds: string[];
  try {
    const match = /\[.*?]/.exec(raw.trim());
    if (!match) return;
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return;
    interestIds = (parsed as unknown[])
      .filter((v): v is string => typeof v === 'string')
      .slice(0, 2);
  } catch {
    logger.warn({ channelId, raw }, 'Channel interest inference: could not parse response');
    return;
  }

  const validIds = new Set(interests.map((t) => t.id));
  const now = new Date().toISOString();
  const inserted: string[] = [];

  for (const interestId of interestIds) {
    if (!validIds.has(interestId)) continue;
    db.prepare(`
      INSERT OR IGNORE INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at)
      VALUES (?, ?, 1.0, ?)
    `).run(channelId, interestId, now);
    inserted.push(interestId);
  }

  if (inserted.length > 0) {
    logger.info({ channelId, interestIds: inserted }, 'Channel interest inference stored');
  }
}
