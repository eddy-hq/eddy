import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import { Worker } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';
import { redis, discoveryQueue, downloadQueue } from '../../queue';
import { ValidationError, NotFoundError } from '../../errors';
import { buildPrompt, parseVerdict, PROMPT_VERSION } from '../guard/index';
import type { DownloadJobData } from '../content';

const execFileAsync = promisify(execFile);
const YTDLP_BIN_M4 = process.env['YTDLP_BIN_M4'] ?? '/opt/homebrew/bin/yt-dlp';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TopicRow {
  id: string;
  label: string;
  category: string | null;
}

interface TopicFullRow extends TopicRow {
  emoji: string | null;
  age_gate: number;
}

interface UserRow {
  user_id: string;
  role: string;
  age_gate: number;
}

interface UserTopicRow {
  topic_id: string;
  label: string;
  weight: number;
  search_terms: string;
}

interface CandidateRow {
  candidate_id: string;
  external_id: string | null;
  title: string | null;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  source_type: string;
  topic_id: string | null;
  person_id: string | null;
}

interface SearchResult {
  videoId: string;
  title: string;
  channel: string;
  durationSecs: number | null;
  viewCount: number | null;
  uploadDate: string | null;
  thumbnailUrl: string | null;
  url: string;
}

// ── Channel topic inference ───────────────────────────────────────────────────

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

// ── Discovery engine ──────────────────────────────────────────────────────────

async function searchTopicVideos(searchTerm: string): Promise<SearchResult[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(YTDLP_BIN_M4, [
      `ytsearch20:${searchTerm}`,
      '--flat-playlist',
      '--dump-json',
      '--no-download',
      '--quiet',
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
    stdout = result.stdout;
  } catch (err) {
    logger.warn({ err, searchTerm }, 'Discovery: yt-dlp search failed');
    return [];
  }

  const results: SearchResult[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      const videoId = item['id'] as string | undefined;
      if (!videoId) continue;

      const thumbnails = item['thumbnails'] as Array<{ url: string }> | undefined;
      const thumbUrl = thumbnails?.find((t) => t.url)?.url
        ?? (item['thumbnail'] as string | undefined)
        ?? null;

      results.push({
        videoId,
        title: String(item['title'] ?? ''),
        channel: String(item['channel'] ?? item['uploader'] ?? ''),
        durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
        viewCount: typeof item['view_count'] === 'number' ? item['view_count'] : null,
        uploadDate: typeof item['upload_date'] === 'string' ? item['upload_date'] : null,
        thumbnailUrl: thumbUrl,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    } catch {
      // skip malformed lines
    }
  }

  return results;
}

function isDuplicateCandidate(userId: string, videoId: string): boolean {
  const inPool = db.prepare(
    'SELECT 1 FROM candidate_pool WHERE user_id = ? AND external_id = ? LIMIT 1'
  ).get(userId, videoId);
  if (inPool) return true;

  const inRequests = db.prepare(
    'SELECT 1 FROM requests WHERE user_id = ? AND youtube_id = ? LIMIT 1'
  ).get(userId, videoId);
  return !!inRequests;
}

function uploadDateToIso(uploadDate: string | null): string | null {
  if (!uploadDate || uploadDate.length !== 8) return null;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`;
}

function daysSince(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function refreshCandidatePool(userId: string, userTopics: UserTopicRow[]): Promise<number> {
  const now = new Date().toISOString();
  let added = 0;

  // Top 5 topics by weight, up to 2 search terms each
  const topTopics = userTopics.slice(0, 5);

  for (const topic of topTopics) {
    let terms: string[];
    try {
      terms = JSON.parse(topic.search_terms) as string[];
      if (!Array.isArray(terms)) terms = [];
    } catch {
      terms = [];
    }

    for (const term of terms.slice(0, 2)) {
      const results = await searchTopicVideos(term);

      for (const result of results) {
        if (isDuplicateCandidate(userId, result.videoId)) continue;

        const publishedAt = uploadDateToIso(result.uploadDate);
        const age = daysSince(publishedAt);
        // Skip videos older than 6 months
        if (age !== null && age > 180) continue;

        db.prepare(`
          INSERT OR IGNORE INTO candidate_pool
            (candidate_id, user_id, content_type, source_type, topic_id,
             url, external_id, title, thumbnail_url, published_at, status, created_at)
          VALUES
            (?, ?, 'video', 'topic_search', ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          uuidv7(), userId, topic.topic_id,
          result.url, result.videoId, result.title,
          result.thumbnailUrl, publishedAt, now
        );
        added++;
      }
    }
  }

  return added;
}

interface ScoringItem {
  index: number;
  candidateId: string;
  title: string;
  channel: string;
  durationSecs: number | null;
  publishedAt: string | null;
}

function formatAge(isoDate: string | null): string {
  const days = daysSince(isoDate);
  if (days === null) return 'unknown age';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

async function scoreCandidates(userId: string, userTopics: UserTopicRow[]): Promise<void> {
  const pending = db.prepare(`
    SELECT candidate_id, external_id, title, url, thumbnail_url, published_at, source_type, topic_id, person_id
    FROM candidate_pool
    WHERE user_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 100
  `).all(userId) as CandidateRow[];

  if (pending.length === 0) return;

  const topicSummary = userTopics
    .map((t) => `${t.label} (weight: ${t.weight.toFixed(1)})`)
    .join(', ');

  const BATCH = 10;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);

    const items: ScoringItem[] = batch.map((c, idx) => {
      // Grab channel from candidate title heuristic; we store it in title as "Title | Channel"
      // Actually title is just the title. We don't store channel separately in candidate_pool.
      // Use what we have.
      return {
        index: idx + 1,
        candidateId: c.candidate_id,
        title: c.title ?? '(no title)',
        channel: '',
        durationSecs: null,
        publishedAt: c.published_at,
      };
    });

    const videoList = items.map((item) =>
      `${item.index}. "${item.title}" | ${formatAge(item.publishedAt)}`
    ).join('\n');

    const prompt = `You are scoring YouTube videos for a personal discovery feed.

User interests: ${topicSummary}

Videos to score:
${videoList}

Return ONLY a compact JSON array — no whitespace, no other text:
[{"index":1,"score":7.5,"why":"One sentence, max 15 words."},...]

Scoring (0–10):
- 8–10: Directly relevant to stated interests and appears quality/substantive
- 5–7: Reasonably relevant or interesting
- 2–4: Weakly relevant
- 0–2: Off-topic, generic, or clickbait
- Penalise: very old content, very short videos on complex topics, generic titles
- Reward: specificity, depth, niche topics matching interests`;

    let raw: string;
    try {
      raw = await ollamaGenerate(prompt);
    } catch (err) {
      logger.warn({ err, userId, batchStart: i }, 'Discovery: scoring Gemma call failed');
      continue;
    }

    interface ScoreEntry { index: number; score: number; why: string; }
    let scores: ScoreEntry[];
    try {
      // Try complete array first; fall back to extracting individual objects
      // from a truncated response.
      const fullMatch = /\[[\s\S]*]/.exec(raw.trim());
      if (fullMatch) {
        scores = JSON.parse(fullMatch[0]) as ScoreEntry[];
      } else {
        const objects = [...raw.matchAll(/\{[^{}]+\}/g)].map((m) => {
          try { return JSON.parse(m[0]) as ScoreEntry; } catch { return null; }
        }).filter((o): o is ScoreEntry => o !== null);
        if (objects.length === 0) {
          logger.warn({ userId, raw: raw.slice(0, 200) }, 'Discovery: could not parse scoring response');
          continue;
        }
        scores = objects;
      }
      if (!Array.isArray(scores)) continue;
    } catch {
      logger.warn({ userId, raw: raw.slice(0, 200) }, 'Discovery: could not parse scoring response');
      continue;
    }

    const now = new Date().toISOString();
    for (const entry of scores) {
      const item = items[entry.index - 1];
      if (!item) continue;
      const score = typeof entry.score === 'number' ? Math.min(10, Math.max(0, entry.score)) : null;
      if (score === null) continue;

      db.prepare(`
        UPDATE candidate_pool
        SET gemma_score = ?, why_text = ?, status = 'scored', scored_at = ?
        WHERE candidate_id = ?
      `).run(score, entry.why ?? null, now, item.candidateId);
    }
  }
}

async function guardCandidates(userId: string): Promise<void> {
  const scored = db.prepare(`
    SELECT candidate_id, external_id, title, url
    FROM candidate_pool
    WHERE user_id = ? AND status = 'scored'
    ORDER BY gemma_score DESC
    LIMIT 30
  `).all(userId) as Array<{ candidate_id: string; external_id: string | null; title: string | null; url: string }>;

  if (scored.length === 0) return;

  const now = new Date().toISOString();

  for (const c of scored) {
    const prompt = buildPrompt({
      requestId: c.candidate_id,
      userId,
      url: c.url,
      title: c.title ?? '',
      channel: '',
      description: '',
      transcript: null,
      channelHistory: { approved: 0, rejected: 0 },
    });

    let verdict: ReturnType<typeof parseVerdict>;
    try {
      const raw = await ollamaGenerate(prompt);
      verdict = parseVerdict(raw);
    } catch {
      verdict = { verdict: 'uncertain', reason: 'Guard error', confidence: 0 };
    }

    db.prepare(`
      INSERT OR IGNORE INTO guard_eval
        (eval_id, request_id, url, gemma_verdict, gemma_reason, gemma_confidence, prompt_version, scored_at, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv7(), c.url, verdict.verdict, verdict.reason, verdict.confidence, PROMPT_VERSION, now, now);

    const nextStatus = verdict.verdict === 'clear_yes' ? 'scored'
      : verdict.verdict === 'clear_no' ? 'guard_rejected'
      : 'guard_pending';

    db.prepare(`
      UPDATE candidate_pool SET guard_verdict = ?, status = ? WHERE candidate_id = ?
    `).run(verdict.verdict, nextStatus, c.candidate_id);
  }
}

function surfaceForToday(userId: string, isKid: boolean): number {
  const today = new Date().toISOString().slice(0, 10);
  const cap = isKid ? 5 : 15;

  // Already surfaced today?
  const alreadySurfaced = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).get(userId, today) as { n: number };
  if (alreadySurfaced.n >= cap) return 0;

  const remaining = cap - alreadySurfaced.n;

  // Candidates eligible to surface: scored (adults) or clear_yes guard (kids)
  const eligibleStatus = isKid ? "'scored'" : "'scored'";
  const eligibleGuard = isKid ? "AND (guard_verdict = 'clear_yes' OR guard_verdict IS NULL)" : '';

  const candidates = db.prepare(`
    SELECT candidate_id FROM candidate_pool
    WHERE user_id = ? AND status = ${eligibleStatus} ${eligibleGuard}
      AND surfaced_date IS NULL
    ORDER BY gemma_score DESC
    LIMIT ?
  `).all(userId, remaining) as Array<{ candidate_id: string }>;

  if (candidates.length === 0) return 0;

  const now = new Date().toISOString();
  for (const c of candidates) {
    db.prepare(`
      UPDATE candidate_pool SET status = 'surfaced', surfaced_date = ?, surfaced_at = ?
      WHERE candidate_id = ?
    `).run(today, now, c.candidate_id);
  }

  return candidates.length;
}

function pruneStalePool(): void {
  const result = db.prepare(`
    DELETE FROM candidate_pool
    WHERE status = 'pending' AND created_at < datetime('now', '-30 days')
  `).run();
  if (result.changes > 0) {
    logger.info({ deleted: result.changes }, 'Discovery: pruned stale candidates');
  }
}

export interface DiscoveryRunResult {
  userId: string;
  skipped: boolean;
  skipReason?: string;
  topicsChecked: number;
  candidatesAdded: number;
  surfaced: number;
  items: Array<{ title: string | null; score: number | null; why: string | null; guardVerdict: string | null }>;
}

export async function runDiscoveryForUser(user: UserRow): Promise<DiscoveryRunResult> {
  const today = new Date().toISOString().slice(0, 10);
  const isKid = user.role === 'kid';
  const cap = isKid ? 5 : 15;

  const existing = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool WHERE user_id = ? AND surfaced_date = ?
  `).get(user.user_id, today) as { n: number };

  if (existing.n >= cap) {
    logger.info({ userId: user.user_id }, 'Discovery: already at cap for today, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'Already at daily cap', topicsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  const userTopics = db.prepare(`
    SELECT ut.topic_id, t.label, ut.weight, t.search_terms
    FROM user_topics ut
    INNER JOIN topics t ON t.id = ut.topic_id
    WHERE ut.user_id = ? ${isKid ? 'AND t.age_gate = 0' : ''}
    ORDER BY ut.weight DESC
  `).all(user.user_id) as UserTopicRow[];

  if (userTopics.length === 0) {
    logger.info({ userId: user.user_id }, 'Discovery: user has no topics, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'No topics set', topicsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  logger.info({ userId: user.user_id, topics: userTopics.length }, 'Discovery: refreshing candidate pool');
  const added = await refreshCandidatePool(user.user_id, userTopics);
  logger.info({ userId: user.user_id, added }, 'Discovery: candidates added to pool');

  await scoreCandidates(user.user_id, userTopics);

  if (isKid) {
    await guardCandidates(user.user_id);
  }

  const surfaced = surfaceForToday(user.user_id, isKid);
  logger.info({ userId: user.user_id, surfaced }, 'Discovery: surfaced for today');

  const items = db.prepare(`
    SELECT title, gemma_score, why_text, guard_verdict
    FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
    ORDER BY gemma_score DESC
  `).all(user.user_id, today) as Array<{ title: string | null; gemma_score: number | null; why_text: string | null; guard_verdict: string | null }>;

  return {
    userId: user.user_id,
    skipped: false,
    topicsChecked: userTopics.length,
    candidatesAdded: added,
    surfaced,
    items: items.map((r) => ({ title: r.title, score: r.gemma_score, why: r.why_text, guardVerdict: r.guard_verdict })),
  };
}

async function runDiscovery(): Promise<void> {
  logger.info('Discovery job started');

  const users = db.prepare(
    "SELECT user_id, role, age_gate FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  for (const user of users) {
    await runDiscoveryForUser(user).catch((err: unknown) => {
      logger.error({ err, userId: user.user_id }, 'Discovery: user run failed');
    });
  }

  pruneStalePool();
  logger.info('Discovery job complete');
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let discoveryWorker: Worker | null = null;

export function startDiscoveryScheduler(): void {
  void discoveryQueue.add('run', {}, {
    repeat: { pattern: '0 6 * * *' },
    jobId: 'discovery-daily',
  }).catch((err: unknown) => logger.warn({ err }, 'Discovery: failed to schedule repeatable job'));

  discoveryWorker = new Worker('discovery', async (job) => {
    if (job.name === 'run') await runDiscovery();
  }, { connection: redis, concurrency: 1 });

  discoveryWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Discovery job completed');
  });
  discoveryWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Discovery job failed');
  });

  logger.info('Discovery scheduler started (daily at 06:00)');
}

export async function stopDiscoveryScheduler(): Promise<void> {
  if (discoveryWorker) {
    await discoveryWorker.close();
    discoveryWorker = null;
  }
}

// ── Topics HTTP router ────────────────────────────────────────────────────────

export const topicsRouter = Router();

function resolveUser(userId: unknown): UserRow {
  if (typeof userId !== 'string' || !userId.trim()) throw new ValidationError('userId required');
  const row = db.prepare(
    'SELECT user_id, role, age_gate FROM users WHERE user_id = ?'
  ).get(userId) as UserRow | undefined;
  if (!row) throw new NotFoundError(`user ${userId}`);
  return row;
}

interface CategoryGroup {
  name: string;
  topics: Array<{ id: string; label: string; emoji: string | null; selected: boolean }>;
}

topicsRouter.get('/', (req: Request, res: Response) => {
  const user = resolveUser(req.query['userId']);
  const isKid = user.role === 'kid' || user.age_gate === 0;

  const allTopics = db.prepare(
    `SELECT id, label, emoji, category, age_gate FROM topics
     ${isKid ? 'WHERE age_gate = 0' : ''}
     ORDER BY category, label`
  ).all() as TopicFullRow[];

  const selectedIds = new Set(
    (db.prepare('SELECT topic_id FROM user_topics WHERE user_id = ?').all(user.user_id) as Array<{ topic_id: string }>)
      .map((r) => r.topic_id)
  );

  const categoryMap = new Map<string, CategoryGroup>();
  for (const t of allTopics) {
    const cat = t.category ?? 'Other';
    if (!categoryMap.has(cat)) categoryMap.set(cat, { name: cat, topics: [] });
    categoryMap.get(cat)!.topics.push({ id: t.id, label: t.label, emoji: t.emoji, selected: selectedIds.has(t.id) });
  }

  res.json({ categories: Array.from(categoryMap.values()), selected_count: selectedIds.size });
});

topicsRouter.post('/select', (req: Request, res: Response) => {
  const { userId, topicId } = req.body as { userId?: string; topicId?: string };
  const user = resolveUser(userId);
  if (!topicId?.trim()) throw new ValidationError('topicId required');

  const topic = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId) as { id: string } | undefined;
  if (!topic) throw new NotFoundError(`topic ${topicId}`);

  db.prepare(`
    INSERT INTO user_topics (user_id, topic_id, weight, liked, added_at)
    VALUES (?, ?, 1.0, 1, ?)
    ON CONFLICT(user_id, topic_id) DO NOTHING
  `).run(user.user_id, topicId, new Date().toISOString());

  res.json({ topicId, selected: true });
});

topicsRouter.delete('/select', (req: Request, res: Response) => {
  const { userId, topicId } = req.body as { userId?: string; topicId?: string };
  const user = resolveUser(userId);
  if (!topicId?.trim()) throw new ValidationError('topicId required');

  db.prepare('DELETE FROM user_topics WHERE user_id = ? AND topic_id = ?')
    .run(user.user_id, topicId);

  res.json({ topicId, selected: false });
});

topicsRouter.post('/user-add', (req: Request, res: Response) => {
  const { userId, label } = req.body as { userId?: string; label?: string };
  const user = resolveUser(userId);
  if (!label?.trim()) throw new ValidationError('label required');

  const trimmed = label.trim();
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
  const topicId = slug || uuidv7();

  const existing = db.prepare('SELECT id FROM topics WHERE id = ? OR label = ?').get(topicId, trimmed) as { id: string } | undefined;
  if (existing) {
    db.prepare(`
      INSERT INTO user_topics (user_id, topic_id, weight, liked, added_at)
      VALUES (?, ?, 1.0, 1, ?)
      ON CONFLICT(user_id, topic_id) DO NOTHING
    `).run(user.user_id, existing.id, new Date().toISOString());
    res.json({ topicId: existing.id, label: trimmed, isNew: false });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms)
    VALUES (?, ?, '🔍', NULL, 0, 'user_added', '[]')
  `).run(topicId, trimmed);

  db.prepare(`
    INSERT INTO user_topics (user_id, topic_id, weight, liked, added_at)
    VALUES (?, ?, 1.0, 1, ?)
    ON CONFLICT(user_id, topic_id) DO NOTHING
  `).run(user.user_id, topicId, now);

  void (async () => {
    const prompt = `Generate 4 YouTube search queries that would find good videos about "${trimmed}". Return a JSON array of strings only, for example ["query one","query two","query three","query four"]. No explanation.`;
    try {
      const raw = await ollamaGenerate(prompt);
      const match = /\[.*?]/s.exec(raw.trim());
      if (match) {
        const parsed: unknown = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const terms = (parsed as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 4);
          db.prepare('UPDATE topics SET search_terms = ? WHERE id = ?').run(JSON.stringify(terms), topicId);
          logger.info({ topicId, terms }, 'User-added topic search terms generated');
        }
      }
    } catch (err) {
      logger.warn({ err, topicId }, 'User-added topic: search term generation failed');
    }
  })();

  res.json({ topicId, label: trimmed, isNew: true });
});

// ── Discovery HTTP router ─────────────────────────────────────────────────────

export const discoveryRouter = Router();

interface SurfacedCandidateRow {
  candidate_id: string;
  url: string;
  external_id: string | null;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  gemma_score: number | null;
  why_text: string | null;
  topic_id: string | null;
  source_type: string;
}

// GET /discovery/feed?userId=
discoveryRouter.get('/feed', (req: Request, res: Response) => {
  const user = resolveUser(req.query['userId']);
  const today = new Date().toISOString().slice(0, 10);

  const candidates = db.prepare(`
    SELECT candidate_id, url, external_id, title, thumbnail_url, published_at,
           gemma_score, why_text, topic_id, source_type
    FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ? AND status = 'surfaced'
    ORDER BY gemma_score DESC
  `).all(user.user_id, today) as SurfacedCandidateRow[];

  const topicCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM user_topics WHERE user_id = ?'
  ).get(user.user_id) as { n: number }).n;

  const coldStart = topicCount === 0 || candidates.length === 0;

  // Balance prompt: dominant topic >70% of today's feed AND no prompt shown in past 10 days
  let balancePrompt: {
    promptId: string;
    topicId: string;
    topicLabel: string;
    concentration: number;
  } | null = null;

  if (candidates.length >= 3) {
    const topicCounts = new Map<string, number>();
    for (const c of candidates) {
      if (c.topic_id) topicCounts.set(c.topic_id, (topicCounts.get(c.topic_id) ?? 0) + 1);
    }
    const [topTopicId, topCount] = [...topicCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

    if (topTopicId && topCount / candidates.length > 0.7) {
      const concentration = topCount / candidates.length;
      const recentPrompt = db.prepare(`
        SELECT 1 FROM balance_prompts
        WHERE user_id = ? AND topic_id = ? AND shown_at > datetime('now', '-10 days')
        LIMIT 1
      `).get(user.user_id, topTopicId);

      if (!recentPrompt) {
        const topicRow = db.prepare('SELECT label FROM topics WHERE id = ?')
          .get(topTopicId) as { label: string } | undefined;
        const promptId = uuidv7();
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO balance_prompts (prompt_id, user_id, topic_id, topic_label, concentration, shown_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(promptId, user.user_id, topTopicId, topicRow?.label ?? topTopicId, concentration, now);
        balancePrompt = { promptId, topicId: topTopicId, topicLabel: topicRow?.label ?? topTopicId, concentration };
      }
    }
  }

  res.json({
    candidates: candidates.map((c) => ({
      candidateId: c.candidate_id,
      url: c.url,
      externalId: c.external_id,
      title: c.title,
      thumbnailUrl: c.thumbnail_url,
      publishedAt: c.published_at,
      score: c.gemma_score,
      why: c.why_text,
      topicId: c.topic_id,
      sourceType: c.source_type,
    })),
    coldStart,
    balancePrompt,
  });
});

// ── Deletion signal ───────────────────────────────────────────────────────────

// Called when a user deletes a downloaded video. Nudges the originating topic
// weight down slightly so future discovery de-prioritises similar content.
export function recordDeletionSignal(userId: string, youtubeId: string): void {
  const candidate = db.prepare(
    'SELECT topic_id FROM candidate_pool WHERE user_id = ? AND external_id = ? LIMIT 1'
  ).get(userId, youtubeId) as { topic_id: string | null } | undefined;

  if (!candidate?.topic_id) return;

  db.prepare(`
    UPDATE user_topics SET weight = MAX(0.1, weight - 0.2)
    WHERE user_id = ? AND topic_id = ?
  `).run(userId, candidate.topic_id);

  logger.info({ topicId: candidate.topic_id }, 'Discovery: deletion signal recorded');
}

// POST /discovery/dismiss — body: { userId, candidateId }
discoveryRouter.post('/dismiss', (req: Request, res: Response) => {
  const { userId, candidateId } = req.body as { userId?: string; candidateId?: string };
  const user = resolveUser(userId);
  if (!candidateId?.trim()) throw new ValidationError('candidateId required');

  const candidate = db.prepare(
    'SELECT candidate_id FROM candidate_pool WHERE candidate_id = ? AND user_id = ?'
  ).get(candidateId, user.user_id) as { candidate_id: string } | undefined;
  if (!candidate) throw new NotFoundError(`candidate ${candidateId}`);

  db.prepare(`UPDATE candidate_pool SET status = 'dismissed' WHERE candidate_id = ?`).run(candidateId);

  res.json({ candidateId, status: 'dismissed' });
});

// POST /discovery/request — body: { userId, candidateId }
discoveryRouter.post('/request', async (req: Request, res: Response) => {
  const { userId, candidateId } = req.body as { userId?: string; candidateId?: string };
  const user = resolveUser(userId);
  if (!candidateId?.trim()) throw new ValidationError('candidateId required');

  const candidate = db.prepare(
    'SELECT candidate_id, url, external_id, title FROM candidate_pool WHERE candidate_id = ? AND user_id = ?'
  ).get(candidateId, user.user_id) as {
    candidate_id: string;
    url: string;
    external_id: string | null;
    title: string | null;
  } | undefined;
  if (!candidate) throw new NotFoundError(`candidate ${candidateId}`);

  const requestId = uuidv7();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, title, status, decided_by, decided_at, requested_at)
    VALUES
      (?, ?, 'recommended', ?, ?, ?, 'downloading', 'auto', ?, ?)
  `).run(requestId, user.user_id, candidate.url, candidate.external_id, candidate.title, now, now);

  const jobData: DownloadJobData = { requestId, youtubeId: candidate.external_id ?? '', url: candidate.url };
  await downloadQueue.add('download', jobData, { jobId: requestId });

  db.prepare(`UPDATE candidate_pool SET status = 'requested' WHERE candidate_id = ?`).run(candidateId);

  logger.info({ requestId, candidateId, userId: user.user_id }, 'Discovery: candidate requested');

  res.status(202).json({ requestId, candidateId, status: 'downloading' });
});
