import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { interestsQueue } from '../../queue';
import { GENERATE_SEARCH_TERMS_JOB, type GenerateSearchTermsJob } from './searchTermsWorker';
import { slugifyInterestLabel } from './util';

export { interestsRouter, removeUserInterest } from './router';
export { normalizeUserAddedInterest, type NormalizedUserInterest } from './normalize';
export { reconcilePendingSearchTerms, SEARCH_TERMS_PENDING } from './reconcile';
export {
  getInferredInterests,
  suppressInferredInterest,
  keepInferredInterest,
  type InferredInterest,
  type KeptInterest,
} from './inferred';
export {
  getDeclaredInterestLinks,
  getDeclaredChannelInterest,
  getEngagedChannelsLackingInterestLinks,
  type DeclaredInterestLink,
  type EngagedChannelLackingLinks,
} from './declaredLinks';

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

// Call 1 — describe the channel's primary topic as a short free-text label,
// unbiased by the existing catalogue. Returns null on an unclear topic OR a
// parse/Gemma failure (both mean "insert nothing" — never force-fit on a thin
// signal), so the caller doesn't distinguish them.
async function describeChannelTopic(channelName: string, recentTitles: string[]): Promise<string | null> {
  const titlesText = recentTitles.length > 0
    ? `\nRecent video titles: ${recentTitles.join('; ')}`
    : '';

  const prompt = `You are labelling a YouTube channel's primary topic for a content recommendation system.

Channel name: "${channelName}"${titlesText}

Give a short, canonical interest label for the MAIN topic of this channel — 1 to 3 words, lowercase, the kind of phrase someone would list as an interest (e.g. "minecraft", "fingerstyle guitar", "formula 1", "marine biology"). Prefer the specific activity or subject over a broad umbrella.

Return JSON: {"label":"<label>"} — or {"label":null} if the channel's topic is unclear. No explanation.`;

  let raw: string;
  try {
    raw = await ollamaGenerate(prompt);
  } catch (err) {
    logger.warn({ err, channelName }, 'Channel topic inference: Gemma call failed');
    return null;
  }

  return parseOllamaJson<string>(raw, 'object', (parsed) => {
    if (parsed === null || typeof parsed !== 'object') return null;
    const v = (parsed as Record<string, unknown>)['label'];
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  });
}

// Call 2 — canonicalise the free label against the existing vocabulary: a
// *semantic same-topic* match (not nearest-fit from a closed list), which is
// what stops a Minecraft channel being force-fit onto an adult seed topic.
// Returns { matchedId } where matchedId is the existing id, or null for a
// confident no-match (⇒ create a new interest). Returns the outer null only on
// a parse/Gemma failure (⇒ insert nothing).
async function canonicaliseInterestLabel(
  label: string,
  vocabulary: InterestRow[],
): Promise<{ matchedId: string | null } | null> {
  if (vocabulary.length === 0) return { matchedId: null };

  const vocabList = vocabulary.map((v) => `${v.id}: ${v.label}`).join('\n');
  const prompt = `You are matching an interest label to a controlled vocabulary for a content recommendation system.

New interest label: "${label}"

Existing interests:
${vocabList}

Is the new label the SAME TOPIC as one of the existing interests above? Match only on genuine topical sameness — a more specific phrasing of the same subject still counts (e.g. "minecraft survival" is the same topic as "minecraft"), but a merely adjacent or broader subject does NOT.

Return JSON: {"match":"<existing id>"} if one is the same topic, or {"match":null} if none is. No explanation.`;

  let raw: string;
  try {
    raw = await ollamaGenerate(prompt);
  } catch (err) {
    logger.warn({ err, label }, 'Interest canonicalisation: Gemma call failed');
    return null;
  }

  const validIds = new Set(vocabulary.map((v) => v.id));
  return parseOllamaJson<{ matchedId: string | null }>(raw, 'object', (parsed) => {
    if (parsed === null || typeof parsed !== 'object') return null;
    const v = (parsed as Record<string, unknown>)['match'];
    if (v === null) return { matchedId: null };
    if (typeof v === 'string' && validIds.has(v)) return { matchedId: v };
    // A non-null `match` that isn't a known id is a hallucinated/garbled id:
    // treat as no-match rather than failure, so we create the topic cleanly.
    if (typeof v === 'string') return { matchedId: null };
    return null;
  });
}

// Channel interest inference (ADR-0008 "Tier 2", issue #181). Bottom-up: Gemma
// freely labels the channel's topic (call 1), then we canonicalise that label
// against the existing interest vocabulary (call 2). A match links the existing
// interest; a genuine miss creates a new 'inferred' interest on demand
// (mirroring normalizeUserAddedInterest) and enqueues its search-terms job.
// This replaces the old "pick 1-2 ids from the full catalogue" prompt, which
// force-fit kid channels onto adult seed topics and leaked them into the
// inferred-interest view.
//
// Canonicalisation is what keeps aggregation intact: many Minecraft channels
// collapse onto one `minecraft` id, so the inferred-interest follower-count and
// the MAX_PER_INTEREST cap still see them as one interest. Best-effort: two
// channels inferred concurrently before either's new row is visible could
// create near-duplicate rows; identical slugs are caught by INSERT OR IGNORE.
export async function inferChannelInterests(channelId: string, channelName: string): Promise<void> {
  const existing = db.prepare(
    'SELECT 1 FROM channel_interest_links WHERE channel_id = ? LIMIT 1'
  ).get(channelId);
  if (existing) return;

  const recentTitles = await fetchRecentTitles(channelId);

  const freeLabel = await describeChannelTopic(channelName, recentTitles);
  if (!freeLabel) return; // unclear/thin signal — insert nothing, never force-fit

  const vocabulary = db.prepare(
    'SELECT id, label, category FROM interests ORDER BY label'
  ).all() as InterestRow[];

  const canonical = await canonicaliseInterestLabel(freeLabel, vocabulary);
  if (!canonical) {
    logger.warn({ channelId, freeLabel }, 'Channel interest inference: could not parse canonicalisation');
    return; // parse failure — insert nothing rather than risk a junk row
  }

  let interestId: string;
  let created = false;
  if (canonical.matchedId) {
    interestId = canonical.matchedId;
  } else {
    const slug = slugifyInterestLabel(freeLabel);
    if (!slug) return; // unsluggable label — nothing to create
    interestId = slug;
    created = true;

    // Create the interest on demand (bottom-up vocabulary growth). Populate
    // search_terms async via the existing chain; isUserAdded=false so the
    // kid-interest guard branch never fires here — inference output is inert
    // until a human Keep, where keepInferredInterest runs the guard.
    db.prepare(`
      INSERT OR IGNORE INTO interests (id, label, category, source, search_terms)
      VALUES (?, ?, NULL, 'inferred', '[]')
    `).run(interestId, freeLabel);

    const payload: GenerateSearchTermsJob = {
      interestId, label: freeLabel, userId: '', isUserAdded: false, isKid: false,
    };
    void interestsQueue.add(GENERATE_SEARCH_TERMS_JOB, payload).catch((err: unknown) => {
      logger.warn({ err, interestId }, 'Inferred interest: failed to enqueue search-terms job');
    });
  }

  db.prepare(`
    INSERT OR IGNORE INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at)
    VALUES (?, ?, 1.0, ?)
  `).run(channelId, interestId, new Date().toISOString());

  logger.info({ channelId, interestId, freeLabel, created }, 'Channel interest inference stored');
}
