import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';

export { interestsRouter } from './router';

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

// ── Free-text interest normalization ──────────────────────────────────────────
//
// Sibling to inferChannelInterests: takes a user-typed label, slugs it,
// resolves to an existing interest if one matches by id or label, otherwise
// creates a new interest row. Always links the resolved interest to the user
// at the next available rank, then kicks off async search-term generation
// for newly-created interests so they're searchable on the next discovery run.

export interface NormalizedUserInterest {
  interestId: string;
  label: string;
  isNew: boolean;
}

export function normalizeUserAddedInterest(userId: string, label: string): NormalizedUserInterest {
  const trimmed = label.trim();
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
  const interestId = slug || uuidv7();
  const now = new Date().toISOString();

  const nextRank = (db.prepare(
    'SELECT COALESCE(MAX(rank), 0) + 1 AS r FROM user_interests WHERE user_id = ?'
  ).get(userId) as { r: number }).r;

  const existing = db.prepare(
    'SELECT id FROM interests WHERE id = ? OR label = ?'
  ).get(interestId, trimmed) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
      VALUES (?, ?, ?, 'comfortable', 1, ?)
      ON CONFLICT(user_id, interest_id) DO NOTHING
    `).run(userId, existing.id, nextRank, now);
    return { interestId: existing.id, label: trimmed, isNew: false };
  }

  db.prepare(`
    INSERT OR IGNORE INTO interests (id, label, category, source, search_terms)
    VALUES (?, ?, NULL, 'user_added', '[]')
  `).run(interestId, trimmed);

  db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
    VALUES (?, ?, ?, 'comfortable', 1, ?)
    ON CONFLICT(user_id, interest_id) DO NOTHING
  `).run(userId, interestId, nextRank, now);

  void generateSearchTermsAsync(interestId, trimmed);

  return { interestId, label: trimmed, isNew: true };
}

async function generateSearchTermsAsync(interestId: string, label: string): Promise<void> {
  const prompt = `Generate 4 YouTube search queries that would find good videos about "${label}". Return a JSON array of strings only, for example ["query one","query two","query three","query four"]. No explanation.`;
  try {
    const raw = await ollamaGenerate(prompt);
    const match = /\[.*?]/s.exec(raw.trim());
    if (match) {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        const terms = (parsed as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 4);
        db.prepare('UPDATE interests SET search_terms = ? WHERE id = ?').run(JSON.stringify(terms), interestId);
        logger.info({ interestId, terms }, 'User-added interest search terms generated');
      }
    }
  } catch (err) {
    logger.warn({ err, interestId }, 'User-added interest: search term generation failed');
  }
}
