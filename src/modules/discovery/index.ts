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
import { evaluateCandidate } from '../guard/index';
import type { DownloadJobData } from '../content';

const execFileAsync = promisify(execFile);
const YTDLP_BIN_M4 = process.env['YTDLP_BIN_M4'] ?? '/opt/homebrew/bin/yt-dlp';

// ── Types ─────────────────────────────────────────────────────────────────────

interface UserRow {
  user_id: string;
  role: string;
  age_gate: number;
}

interface UserInterestRow {
  interest_id: string;
  label: string;
  rank: number;
  expertise: 'beginner' | 'comfortable' | 'deep';
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
  interest_id: string | null;
  interest_label: string | null;
  person_id: string | null;
  person_name: string | null;
  channel: string | null;
  duration_secs: number | null;
  interest_expertise: string | null;
  time_sensitivity: string | null;
}

interface SearchResult {
  videoId: string;
  title: string;
  channel: string;
  durationSecs: number | null;
  viewCount: number | null;
  uploadDate: string | null;
  thumbnailUrl: string | null;
  liveStatus: string | null;
  url: string;
}

// ── Discovery engine ──────────────────────────────────────────────────────────

async function searchInterestVideos(searchTerm: string): Promise<SearchResult[]> {
  // --print with a field template gives us upload_date (which --flat-playlist
  // never returns) without dragging in all the format metadata that full
  // extraction normally produces. Slower than flat-playlist but freshness
  // ranking depends on real dates.
  let stdout: string;
  try {
    const result = await execFileAsync(YTDLP_BIN_M4, [
      `ytsearch20:${searchTerm}`,
      '--print',
      '%(.{id,title,channel,duration,view_count,upload_date,timestamp,thumbnail,live_status})j',
      '--no-download',
      '--quiet',
      '--no-warnings',
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 90_000 });
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

      results.push({
        videoId,
        title: String(item['title'] ?? ''),
        channel: String(item['channel'] ?? ''),
        durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
        viewCount: typeof item['view_count'] === 'number' ? item['view_count'] : null,
        uploadDate: typeof item['upload_date'] === 'string' ? item['upload_date'] : null,
        thumbnailUrl: typeof item['thumbnail'] === 'string' ? item['thumbnail'] : null,
        liveStatus: typeof item['live_status'] === 'string' ? item['live_status'] : null,
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

// Freshness window at intake. Older content is dropped before it ever
// reaches scoring. Set generous so the pool has volume — surfacing applies
// a per-day decay (1.6× for <24h down to 0.4× for >90 days) so fresh wins
// on ranking even when older items are present.
const FRESHNESS_WINDOW_DAYS = 180;

// Drop YouTube Shorts at intake. Sub-90s clips break the model Eddy is
// built around: completion telemetry is meaningless, hooks ("max 15
// words, specific not generic") are longer than the video, and the 9:16
// format doesn't fit the 16:9 grid. Kids can still share individual
// shorts via the iOS Shortcut → guard path.
export const SHORTS_MAX_SECS = 90;

async function refreshCandidatePool(userId: string, userInterests: UserInterestRow[]): Promise<number> {
  const now = new Date().toISOString();
  let added = 0;

  // Search up to 10 interests so lower-ranked ones can still surprise the
  // feed. Top 3 get two search terms; ranks 4–10 get one to keep the search
  // budget bounded (~13 yt-dlp calls/user/day worst case).
  const interestsToSearch = userInterests.slice(0, 10);

  for (const interest of interestsToSearch) {
    let terms: string[];
    try {
      terms = JSON.parse(interest.search_terms) as string[];
      if (!Array.isArray(terms)) terms = [];
    } catch {
      terms = [];
    }

    const termCount = interest.rank <= 3 ? 2 : 1;

    for (const term of terms.slice(0, termCount)) {
      const results = await searchInterestVideos(term);

      for (const result of results) {
        if (isDuplicateCandidate(userId, result.videoId)) continue;
        if (result.durationSecs !== null && result.durationSecs <= SHORTS_MAX_SECS) continue;
        if (result.liveStatus === 'is_live' || result.liveStatus === 'is_upcoming') continue;

        const publishedAt = uploadDateToIso(result.uploadDate);
        const age = daysSince(publishedAt);
        if (age !== null && age > FRESHNESS_WINDOW_DAYS) continue;

        db.prepare(`
          INSERT OR IGNORE INTO candidate_pool
            (candidate_id, user_id, content_type, source_type, interest_id,
             url, external_id, title, channel, duration_secs, thumbnail_url,
             published_at, status, created_at)
          VALUES
            (?, ?, 'video', 'interest_search', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          uuidv7(), userId, interest.interest_id,
          result.url, result.videoId, result.title,
          result.channel || null, result.durationSecs,
          result.thumbnailUrl, publishedAt, now
        );
        added++;
      }
    }
  }

  return added;
}

// ── Back-catalog seeder ───────────────────────────────────────────────────────
//
// Followed-channel uploads from the moment of follow forward arrive via the
// RSS poller (modules/people) and land directly in `requests` under the
// "From people you follow" feed section. That path never reaches the
// candidate pool, so the back catalog of a creator a kid just started
// following is invisible to discovery unless we deliberately mine it.
//
// `seedBackCatalogCandidates` does that: pulls a flat playlist for each
// followed YouTube output, removes anything already touched by RSS or
// already a candidate/request, samples a small budget per channel, and
// inserts those into the candidate pool with `source_type =
// 'person_backcatalog'`. From there they run through the same scoring,
// guard, and surfacing pipeline as interest-search candidates — they
// earn their place on score, not on source.

interface FollowedYoutubeOutput {
  output_id: string;
  person_id: string;
  channel_id: string;
  display_name: string;
}

interface PlaylistEntry {
  videoId: string;
  title: string;
  durationSecs: number | null;
  liveStatus: string | null;
}

const PER_CHANNEL_BACKCATALOG_BUDGET = 3;
const MAX_BACKCATALOG_PER_USER = 20;

async function fetchChannelPlaylist(channelId: string): Promise<PlaylistEntry[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(YTDLP_BIN_M4, [
      `https://www.youtube.com/channel/${channelId}/videos`,
      '--flat-playlist',
      '--print', '%(.{id,title,duration,live_status})j',
      '--no-download',
      '--quiet',
      '--no-warnings',
    ], { maxBuffer: 50 * 1024 * 1024, timeout: 60_000 });
    stdout = result.stdout;
  } catch (err) {
    logger.warn({ err, channelId }, 'Back-catalog: flat-playlist fetch failed');
    return [];
  }

  const entries: PlaylistEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      const videoId = item['id'] as string | undefined;
      if (!videoId) continue;
      entries.push({
        videoId,
        title: String(item['title'] ?? ''),
        durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
        liveStatus: typeof item['live_status'] === 'string' ? item['live_status'] : null,
      });
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

async function seedBackCatalogCandidates(userId: string): Promise<number> {
  const followed = db.prepare(`
    SELECT po.output_id, po.person_id, po.external_id AS channel_id, p.display_name
    FROM followed_people fp
    INNER JOIN person_outputs po ON po.person_id = fp.person_id
    INNER JOIN people p ON p.person_id = fp.person_id
    WHERE fp.user_id = ? AND po.output_type = 'youtube' AND po.active = 1
  `).all(userId) as FollowedYoutubeOutput[];

  if (followed.length === 0) return 0;

  // Process channels in a randomized order so a user with > MAX/PER_CHANNEL
  // followed channels gets a different mix sampled each day.
  shuffleInPlace(followed);

  const now = new Date().toISOString();
  let totalAdded = 0;

  for (const output of followed) {
    if (totalAdded >= MAX_BACKCATALOG_PER_USER) break;

    const playlist = await fetchChannelPlaylist(output.channel_id);
    if (playlist.length === 0) continue;

    const seenIds = new Set(
      (db.prepare(
        'SELECT video_id FROM seen_videos WHERE channel_id = ?'
      ).all(output.channel_id) as Array<{ video_id: string }>).map((r) => r.video_id)
    );

    const eligible = playlist.filter((v) => {
      if (seenIds.has(v.videoId)) return false;
      if (v.durationSecs !== null && v.durationSecs <= SHORTS_MAX_SECS) return false;
      if (v.liveStatus === 'is_live' || v.liveStatus === 'is_upcoming') return false;
      if (isDuplicateCandidate(userId, v.videoId)) return false;
      return true;
    });

    if (eligible.length === 0) continue;

    // Channel→interest mapping (from inferChannelInterests at follow time)
    // gives the candidate an interest_id, so the per-interest cap engages
    // and rank-weighted surfacing works the same way as interest-search.
    const interestRow = db.prepare(`
      SELECT interest_id FROM channel_interest_links
      WHERE channel_id = ? ORDER BY confidence DESC LIMIT 1
    `).get(output.channel_id) as { interest_id: string } | undefined;
    const interestId = interestRow?.interest_id ?? null;

    const sampled = shuffleInPlace(eligible).slice(0, PER_CHANNEL_BACKCATALOG_BUDGET);

    for (const video of sampled) {
      if (totalAdded >= MAX_BACKCATALOG_PER_USER) break;
      const url = `https://www.youtube.com/watch?v=${video.videoId}`;
      db.prepare(`
        INSERT OR IGNORE INTO candidate_pool
          (candidate_id, user_id, content_type, source_type, person_id, interest_id,
           url, external_id, title, channel, duration_secs,
           status, created_at)
        VALUES
          (?, ?, 'video', 'person_backcatalog', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        uuidv7(), userId, output.person_id, interestId,
        url, video.videoId, video.title || null,
        output.display_name, video.durationSecs,
        now
      );
      totalAdded++;
    }
  }

  return totalAdded;
}

interface ScoringItem {
  index: number;
  candidateId: string;
  title: string;
  channel: string;
  durationSecs: number | null;
  publishedAt: string | null;
  interestLabel: string | null;
  expertise: string | null;
  sourceType: string;
  personName: string | null;
}

// Brief §9a: "If Gemma can't explain why, the item doesn't surface."
// Hard floor — items below either threshold are filtered at surface time.
export const MIN_CONNECTION_SCORE = 6;
export const MIN_QUALITY_SCORE = 5;

// Floor on the combined weighted score (connection × quality × freshness ×
// (1/√rank)). Stops the per-interest cap from forcing in weak picks just
// because nothing better exists for that interest — e.g. a 2-year-old
// match highlight with freshness ×0.1 scores ≈ 1, which is noise.
// Roughly equivalent to: a baseline candidate (conn 6, qual 5, fresh 0.5,
// rank 5) clears it; an old news item (conn 9, qual 6, fresh 0.1, rank 11)
// does not.
export const MIN_WEIGHTED_SCORE = 5;

function formatAge(isoDate: string | null): string {
  const days = daysSince(isoDate);
  if (days === null) return 'unknown age';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatDuration(secs: number | null): string {
  if (secs === null || secs <= 0) return 'unknown length';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export type TimeSensitivity = 'news' | 'standard' | 'evergreen';

function normalizeSensitivity(s: string | null | undefined): TimeSensitivity {
  if (s === 'news' || s === 'evergreen') return s;
  return 'standard';
}

// Decay applied at surfacing time, picked per content type:
//   news      — value drops fast (e.g. yesterday's match highlights)
//   standard  — most tutorials, fairly time-bound but not urgent
//   evergreen — technique fundamentals, philosophy, classic retrospectives
// A null/unknown sensitivity falls back to 'standard'.
export function freshnessMultiplier(
  publishedAt: string | null,
  sensitivity: string | null = 'standard',
): number {
  const days = daysSince(publishedAt);
  const kind = normalizeSensitivity(sensitivity);

  if (days === null) {
    if (kind === 'news') return 0.5;
    if (kind === 'evergreen') return 1.0;
    return 0.8;
  }

  if (kind === 'news') {
    if (days <= 1) return 1.6;
    if (days <= 2) return 1.2;
    if (days <= 7) return 0.6;
    if (days <= 30) return 0.2;
    if (days <= 90) return 0.1;
    return 0.05;
  }

  if (kind === 'evergreen') {
    if (days <= 1) return 1.4;
    if (days <= 7) return 1.2;
    if (days <= 30) return 1.1;
    if (days <= 365) return 1.0;
    return 0.9;
  }

  // standard
  if (days <= 1) return 1.6;
  if (days <= 2) return 1.4;
  if (days <= 7) return 1.2;
  if (days <= 30) return 1.0;
  if (days <= 90) return 0.7;
  return 0.4;
}

function clampScore(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, n));
}

// Deterministic time-sensitivity override for patterns Gemma keeps flip-
// flopping on. Match highlights and dated sports content are unambiguously
// news; relying on the model gave inconsistent verdicts even at temp 0.2.
// Only override TOWARD news — never override Gemma down to standard.
function overrideTimeSensitivity(title: string | null, modelSays: TimeSensitivity): TimeSensitivity {
  if (modelSays === 'news') return 'news';
  if (!title) return modelSays;
  const t = title.toLowerCase();

  // Match highlights, recap-style sports content
  if (/\bmatch highlights\b/.test(t)) return 'news';
  if (/\bhighlights\s*[|:]/.test(t)) return 'news';

  // Team-vs-team score patterns ("3-0", "5-1") with sport indicators
  if (/\b\d{1,2}[-–]\d{1,2}\b/.test(t) && /\b(vs\.?|match|full match|fc|united|city|town)\b/i.test(title)) {
    return 'news';
  }

  // Football season tags (e.g. "2024/25", "2025/26") — implies current season
  if (/\b20\d{2}\/2\d\b/.test(t)) return 'news';

  return modelSays;
}

export async function scoreCandidates(userId: string, userInterests: UserInterestRow[]): Promise<void> {
  // JOIN to surface the seeding interest's label + the user's expertise level
  // for that interest, so Gemma can name the connection specifically rather
  // than guess from a list of interests.
  const pending = db.prepare(`
    SELECT c.candidate_id, c.external_id, c.title, c.url, c.thumbnail_url,
           c.published_at, c.source_type, c.interest_id, c.person_id,
           c.channel, c.duration_secs,
           i.label AS interest_label,
           ui.expertise AS interest_expertise,
           p.display_name AS person_name
    FROM candidate_pool c
    LEFT JOIN interests i ON i.id = c.interest_id
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    LEFT JOIN people p ON p.person_id = c.person_id
    WHERE c.user_id = ? AND c.status = 'pending'
    ORDER BY c.created_at DESC
    LIMIT 100
  `).all(userId) as CandidateRow[];

  if (pending.length === 0) return;

  const interestSummary = userInterests
    .map((t) => `"${t.label}" (${t.expertise})`)
    .join(', ');

  const BATCH = 10;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);

    const items: ScoringItem[] = batch.map((c, idx) => ({
      index: idx + 1,
      candidateId: c.candidate_id,
      title: c.title ?? '(no title)',
      channel: c.channel ?? '',
      durationSecs: c.duration_secs,
      publishedAt: c.published_at,
      interestLabel: c.interest_label,
      expertise: c.interest_expertise,
      sourceType: c.source_type,
      personName: c.person_name,
    }));

    const videoList = items.map((item) => {
      const channel = item.channel ? item.channel : 'unknown channel';
      const seedTag = item.interestLabel
        ? ` [seeded by interest: "${item.interestLabel}"${item.expertise ? `, ${item.expertise}` : ''}]`
        : '';
      const followTag = item.sourceType === 'person_backcatalog' && item.personName
        ? ` [back-catalog from a person you follow: ${item.personName}]`
        : '';
      return `${item.index}. "${item.title}" — ${channel} | ${formatDuration(item.durationSecs)} | ${formatAge(item.publishedAt)}${seedTag}${followTag}`;
    }).join('\n');

    const prompt = `Score YouTube videos for a personal discovery feed. For each video give a connection score, a quality score, a time-sensitivity tag, and a one-sentence reason.

User interests (priority order, expertise): ${interestSummary}

Videos (title — channel | length | age [seeded by interest] [back-catalog from a person you follow]):
${videoList}

Return ONLY this JSON, one entry per video, no other text:
[{"index":1,"connection":7,"quality":8,"time_sensitivity":"standard","why":"Names the matched interest and a specific aspect of THIS video, max 20 words."}]

CONNECTION (0–10): match to a named interest at the user's expertise level.
- 8–10: clearly and specifically matches a named interest
- 5–7: adjacent or partial match
- 0–4: weak or no clear match
If you can't articulate which interest matches and what specific aspect, score ≤ 3.

QUALITY (0–10): substance over engagement bait. Score quality ≤ 4 if the title contains any of these bait patterns:
- Money in title without specific company context — "$650M Exit", "Make $1M with X", "How I made $X"
- Cure-all framing — "Read this and win", "Watch this to know X", "The only X you need"
- ALL CAPS shouting or hyperbolic phrasing — "EXACTLY", "INSANE", "FAST", "SECRETS", "Don't waste"
- Parasocial framing — "How I'd build", "If I were starting over", "What I wish I knew"
- Year + Roadmap pairing where the year exists to look fresh — "Complete 2026 Roadmap"
- Mismatched duration — 60s shorts claiming complex skills, 30min for trivial topics
- Reaction or compilation-farm channels

Reward specificity (named techniques, specific scores, real expertise) and descriptive titles beyond a hook.

TIME_SENSITIVITY:
- "news": value drops within days — match highlights, "X just announced", recent dates
- "standard": tutorials, year-stamped roadmaps, trend pieces
- "evergreen": fundamentals, history, philosophy, classic retrospectives

If a video is tagged "[back-catalog from a person you follow: NAME]", name that person in the "why" — e.g. "NAME has a video on {specific aspect} you haven't seen". The follow does not change the connection or quality scores; the user still has to want this specific video.

The "why" must name the matched interest and something specific about THIS video. Generic phrasing means connection ≤ 3. Do not consider freshness or popularity in the scores — those are applied separately.`;

    let raw: string;
    try {
      // Three-axis scoring + sensitivity tag + specific why-text runs ~200
      // tokens per video. Batch of 10 needs headroom. Low temperature so the
      // same video gets the same score across runs — score-prompt iteration
      // shouldn't be fighting model variance.
      raw = await ollamaGenerate(prompt, undefined, undefined, {
        num_predict: 3000,
        temperature: 0.2,
      });
    } catch (err) {
      logger.warn({ err, userId, batchStart: i }, 'Discovery: scoring Gemma call failed');
      continue;
    }

    interface ScoreEntry { index: number; connection?: number; quality?: number; time_sensitivity?: string; why?: string; score?: number; }
    let scores: ScoreEntry[];
    try {
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

      const connection = clampScore(entry.connection);
      const quality = clampScore(entry.quality);
      if (connection === null || quality === null) continue;

      const sensitivity: TimeSensitivity = item.sourceType === 'person_backcatalog'
        // Back-catalog: the upload date is years old by definition, but the
        // user's *discovery* of it is what's fresh. Forcing evergreen
        // sidesteps the news/standard decay curves (which would crush a
        // 5-year-old video to a 0.05–0.4× multiplier) and lets back-catalog
        // candidates compete at face value on connection × quality.
        ? 'evergreen'
        : (() => {
          const v = (entry.time_sensitivity ?? '').toString().toLowerCase().trim();
          const modelSays: TimeSensitivity = v === 'news' || v === 'evergreen' ? v : 'standard';
          return overrideTimeSensitivity(item.title, modelSays);
        })();

      // gemma_score retained as connection × quality / 10 (0–10 range) so
      // older code paths (e.g. guardCandidates' top-N) still work.
      const combined = (connection * quality) / 10;

      db.prepare(`
        UPDATE candidate_pool
        SET connection_score = ?, quality_score = ?, gemma_score = ?,
            time_sensitivity = ?, why_text = ?, status = 'scored', scored_at = ?
        WHERE candidate_id = ?
      `).run(connection, quality, combined, sensitivity, entry.why ?? null, now, item.candidateId);
    }
  }
}

// Brief §9a: weight = 1/sqrt(rank). Lower-ranked interests are down-weighted,
// not eliminated, so the feed still leans on top interests but lets niche
// ones surface when their content is fresh and high quality.
export function rankWeight(rank: number): number {
  return 1 / Math.sqrt(Math.max(1, rank));
}

// Diversity rules: a daily feed of 15 picks should span many interests. A
// 2-per-interest cap with 12 interests yields ≥7 distinct interests in a
// full slate. Title-similarity dedup catches the "5 nearly identical
// running-form videos" case within a single interest.
const MAX_PER_INTEREST_ADULT = 2;
const MAX_PER_INTEREST_KID = 1;
const TITLE_SIMILARITY_THRESHOLD = 0.4;

const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'how', 'what',
  'why', 'this', 'that', 'these', 'those', 'just', 'will', 'from', 'into',
  'about', 'over', 'than', 'when', 'where', 'best',
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface AllocatableItem {
  candidateId: string;
  title: string | null;
  interestId: string | null;
  rank: number;
  weighted: number;
}

export interface AllocateOptions {
  cap: number;
  isKid: boolean;
  prefilledTitles?: string[];
  prefilledInterestCounts?: Map<string, number>;
}

// Greedy slot allocation honouring per-interest cap, title-similarity
// dedup, and the rank>3 stretch reservation. Used by both surfaceForToday
// and the preview's simulation so they always agree on selection rules.
export function allocateSlots(
  ranked: AllocatableItem[],
  opts: AllocateOptions,
): Map<string, 'regular' | 'stretch'> {
  const { cap, isKid, prefilledTitles = [], prefilledInterestCounts = new Map() } = opts;
  const maxPerInterest = isKid ? MAX_PER_INTEREST_KID : MAX_PER_INTEREST_ADULT;
  const stretchQuota = Math.max(1, Math.floor(cap * 0.2));
  const regularQuota = cap - stretchQuota;

  const selected = new Map<string, 'regular' | 'stretch'>();
  const interestCounts = new Map<string, number>(prefilledInterestCounts);
  const selectedTokenSets: Set<string>[] = prefilledTitles.map(titleTokens);

  function tryPick(item: AllocatableItem, slot: 'regular' | 'stretch', honourInterestCap: boolean): boolean {
    if (selected.has(item.candidateId)) return false;

    if (honourInterestCap && item.interestId) {
      const count = interestCounts.get(item.interestId) ?? 0;
      if (count >= maxPerInterest) return false;
    }

    if (item.title) {
      const tokens = titleTokens(item.title);
      for (const existing of selectedTokenSets) {
        if (jaccardSimilarity(tokens, existing) >= TITLE_SIMILARITY_THRESHOLD) return false;
      }
      selectedTokenSets.push(tokens);
    }

    selected.set(item.candidateId, slot);
    if (item.interestId) {
      interestCounts.set(item.interestId, (interestCounts.get(item.interestId) ?? 0) + 1);
    }
    return true;
  }

  // Pass 1 — regular slots, top weighted, honour interest cap + similarity
  for (const item of ranked) {
    if (selected.size >= regularQuota) break;
    tryPick(item, 'regular', true);
  }

  // Pass 2 — stretch slots, items from interests outside top-3 only
  for (const item of ranked) {
    if (selected.size >= regularQuota + stretchQuota) break;
    if (item.rank <= 3) continue;
    tryPick(item, 'stretch', true);
  }

  // No Pass-3 cap-relaxing backfill: if diversity rules leave the feed
  // short, that's a valid outcome. Brief §9a: "Finishing 'Picked for you'
  // is a valid state — show 'That's it for today' rather than paginating."

  return selected;
}

function surfaceForToday(userId: string, isKid: boolean): number {
  const today = new Date().toISOString().slice(0, 10);
  const cap = isKid ? 5 : 15;

  const alreadySurfaced = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).get(userId, today) as { n: number };
  if (alreadySurfaced.n >= cap) return 0;

  const remaining = cap - alreadySurfaced.n;
  const eligibleGuard = isKid ? "AND (c.guard_verdict = 'clear_yes' OR c.guard_verdict IS NULL)" : '';

  // History exclusion: anything we already have a record of — requested,
  // downloaded, deleted, or rejected — must never resurface via discovery.
  // The status filter handles candidates whose pool row has already
  // changed state; the NOT EXISTS clause covers requests sourced
  // independently (share-sheet, search) where the candidate_pool row
  // wasn't updated.
  const candidates = db.prepare(`
    SELECT c.candidate_id, c.title, c.published_at, c.connection_score,
           c.quality_score, c.time_sensitivity, c.interest_id,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.status = 'scored' ${eligibleGuard}
      AND c.surfaced_date IS NULL
      AND c.connection_score >= ${MIN_CONNECTION_SCORE}
      AND c.quality_score >= ${MIN_QUALITY_SCORE}
      AND NOT EXISTS (
        SELECT 1 FROM requests r
        WHERE r.user_id = c.user_id AND r.youtube_id = c.external_id
      )
  `).all(userId) as Array<{
    candidate_id: string;
    title: string | null;
    published_at: string | null;
    connection_score: number | null;
    quality_score: number | null;
    time_sensitivity: string | null;
    interest_id: string | null;
    rank: number;
  }>;

  if (candidates.length === 0) return 0;

  const ranked: AllocatableItem[] = candidates
    .map((c) => ({
      candidateId: c.candidate_id,
      title: c.title,
      interestId: c.interest_id,
      rank: c.rank,
      weighted: (c.connection_score ?? 0)
        * (c.quality_score ?? 0)
        * freshnessMultiplier(c.published_at, c.time_sensitivity)
        * rankWeight(c.rank),
    }))
    .filter((x) => x.weighted >= MIN_WEIGHTED_SCORE)
    .sort((a, b) => b.weighted - a.weighted);

  if (ranked.length === 0) return 0;

  // Carry over today's already-surfaced titles + interest counts so a
  // mid-day re-run doesn't pile more from the same interest or echo a
  // similar title.
  const surfacedToday = db.prepare(`
    SELECT title, interest_id FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).all(userId, today) as Array<{ title: string | null; interest_id: string | null }>;

  const prefilledTitles = surfacedToday.map((r) => r.title ?? '').filter((t) => t.length > 0);
  const prefilledInterestCounts = new Map<string, number>();
  for (const r of surfacedToday) {
    if (!r.interest_id) continue;
    prefilledInterestCounts.set(r.interest_id, (prefilledInterestCounts.get(r.interest_id) ?? 0) + 1);
  }

  const picked = allocateSlots(ranked, {
    cap: remaining,
    isKid,
    prefilledTitles,
    prefilledInterestCounts,
  });

  if (picked.size === 0) return 0;

  const now = new Date().toISOString();
  for (const candidateId of picked.keys()) {
    db.prepare(`
      UPDATE candidate_pool SET status = 'surfaced', surfaced_date = ?, surfaced_at = ?
      WHERE candidate_id = ?
    `).run(today, now, candidateId);
  }

  return picked.size;
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
  interestsChecked: number;
  candidatesAdded: number;
  surfaced: number;
  items: Array<{ title: string | null; score: number | null; why: string | null; guardVerdict: string | null }>;
}

export async function runDiscoveryForUser(user: UserRow, options: { force?: boolean } = {}): Promise<DiscoveryRunResult> {
  const today = new Date().toISOString().slice(0, 10);
  const isKid = user.role === 'kid';
  const cap = isKid ? 5 : 15;

  const existing = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool WHERE user_id = ? AND surfaced_date = ?
  `).get(user.user_id, today) as { n: number };

  if (existing.n >= cap && !options.force) {
    logger.info({ userId: user.user_id }, 'Discovery: already at cap for today, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'Already at daily cap (use --force to override)', interestsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  const userInterests = db.prepare(`
    SELECT ut.interest_id, t.label, ut.rank, ut.expertise, t.search_terms
    FROM user_interests ut
    INNER JOIN interests t ON t.id = ut.interest_id
    WHERE ut.user_id = ?
    ORDER BY ut.rank ASC
  `).all(user.user_id) as UserInterestRow[];

  if (userInterests.length === 0) {
    logger.info({ userId: user.user_id }, 'Discovery: user has no interests, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'No interests set', interestsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  logger.info({ userId: user.user_id, interests: userInterests.length }, 'Discovery: refreshing candidate pool');
  const interestSearchAdded = await refreshCandidatePool(user.user_id, userInterests);
  logger.info({ userId: user.user_id, added: interestSearchAdded }, 'Discovery: interest-search candidates added');

  const backCatalogAdded = await seedBackCatalogCandidates(user.user_id);
  logger.info({ userId: user.user_id, added: backCatalogAdded }, 'Discovery: back-catalog candidates added');

  const added = interestSearchAdded + backCatalogAdded;

  await scoreCandidates(user.user_id, userInterests);

  if (isKid) {
    const scored = db.prepare(`
      SELECT candidate_id, title, url
      FROM candidate_pool
      WHERE user_id = ? AND status = 'scored'
      ORDER BY gemma_score DESC
      LIMIT 30
    `).all(user.user_id) as Array<{ candidate_id: string; title: string | null; url: string }>;

    for (const c of scored) {
      const verdict = await evaluateCandidate({
        candidateId: c.candidate_id,
        userId: user.user_id,
        url: c.url,
        title: c.title ?? '',
      });

      const nextStatus = verdict.verdict === 'clear_yes' ? 'scored'
        : verdict.verdict === 'clear_no' ? 'guard_rejected'
        : 'guard_pending';

      db.prepare(`
        UPDATE candidate_pool SET guard_verdict = ?, status = ? WHERE candidate_id = ?
      `).run(verdict.verdict, nextStatus, c.candidate_id);
    }
  }

  const surfaced = surfaceForToday(user.user_id, isKid);
  logger.info({ userId: user.user_id, surfaced }, 'Discovery: surfaced for today');

  const items = db.prepare(`
    SELECT c.title, c.gemma_score, c.connection_score, c.quality_score,
           c.time_sensitivity, c.why_text, c.guard_verdict, c.published_at,
           c.interest_id, COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.surfaced_date = ?
  `).all(user.user_id, today) as Array<{
    title: string | null;
    gemma_score: number | null;
    connection_score: number | null;
    quality_score: number | null;
    time_sensitivity: string | null;
    why_text: string | null;
    guard_verdict: string | null;
    published_at: string | null;
    interest_id: string | null;
    rank: number;
  }>;

  const sortedItems = items
    .map((r) => ({
      row: r,
      weighted: (r.connection_score ?? 0)
        * (r.quality_score ?? 0)
        * freshnessMultiplier(r.published_at, r.time_sensitivity)
        * rankWeight(r.rank),
    }))
    .sort((a, b) => b.weighted - a.weighted)
    .map((x) => x.row);

  return {
    userId: user.user_id,
    skipped: false,
    interestsChecked: userInterests.length,
    candidatesAdded: added,
    surfaced,
    items: sortedItems.map((r) => ({ title: r.title, score: r.gemma_score, why: r.why_text, guardVerdict: r.guard_verdict })),
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

// ── Discovery HTTP router ─────────────────────────────────────────────────────

export const discoveryRouter = Router();

function resolveUser(userId: unknown): UserRow {
  if (typeof userId !== 'string' || !userId.trim()) throw new ValidationError('userId required');
  const row = db.prepare(
    'SELECT user_id, role, age_gate FROM users WHERE user_id = ?'
  ).get(userId) as UserRow | undefined;
  if (!row) throw new NotFoundError(`user ${userId}`);
  return row;
}

// GET /discovery/preview-html?user=<name|id>
// Visual dry-run of surfacing logic, served to the local network so it's
// reachable from any device over Tailscale without copying files around.
discoveryRouter.get('/preview-html', async (req: Request, res: Response) => {
  // Dynamic import keeps preview.ts lazy and avoids circular-dep issues at
  // module init time (preview.ts imports helpers from this module).
  const { renderPreviewHtml } = await import('./preview');
  const target = typeof req.query['user'] === 'string' ? req.query['user'] : null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPreviewHtml(target));
});

interface SurfacedCandidateRow {
  candidate_id: string;
  url: string;
  external_id: string | null;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  gemma_score: number | null;
  connection_score: number | null;
  quality_score: number | null;
  time_sensitivity: string | null;
  why_text: string | null;
  interest_id: string | null;
  source_type: string;
  rank: number;
}

// GET /discovery/feed?userId=
discoveryRouter.get('/feed', (req: Request, res: Response) => {
  const user = resolveUser(req.query['userId']);
  const today = new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT c.candidate_id, c.url, c.external_id, c.title, c.thumbnail_url, c.published_at,
           c.gemma_score, c.connection_score, c.quality_score, c.time_sensitivity,
           c.why_text, c.interest_id, c.source_type,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.surfaced_date = ? AND c.status = 'surfaced'
  `).all(user.user_id, today) as SurfacedCandidateRow[];

  const candidates = rows
    .map((r) => ({
      row: r,
      weighted: (r.connection_score ?? 0)
        * (r.quality_score ?? 0)
        * freshnessMultiplier(r.published_at, r.time_sensitivity)
        * rankWeight(r.rank),
    }))
    .sort((a, b) => b.weighted - a.weighted)
    .map((x) => x.row);

  const interestCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM user_interests WHERE user_id = ?'
  ).get(user.user_id) as { n: number }).n;

  const coldStart = interestCount === 0 || candidates.length === 0;

  // Balance prompt: dominant interest >70% of today's feed AND no prompt shown in past 10 days
  let balancePrompt: {
    promptId: string;
    interestId: string;
    interestLabel: string;
    concentration: number;
  } | null = null;

  if (candidates.length >= 3) {
    const interestCounts = new Map<string, number>();
    for (const c of candidates) {
      if (c.interest_id) interestCounts.set(c.interest_id, (interestCounts.get(c.interest_id) ?? 0) + 1);
    }
    const [topInterestId, topCount] = [...interestCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

    if (topInterestId && topCount / candidates.length > 0.7) {
      const concentration = topCount / candidates.length;
      const recentPrompt = db.prepare(`
        SELECT 1 FROM balance_prompts
        WHERE user_id = ? AND interest_id = ? AND shown_at > datetime('now', '-10 days')
        LIMIT 1
      `).get(user.user_id, topInterestId);

      if (!recentPrompt) {
        const interestRow = db.prepare('SELECT label FROM interests WHERE id = ?')
          .get(topInterestId) as { label: string } | undefined;
        const promptId = uuidv7();
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO balance_prompts (prompt_id, user_id, interest_id, interest_label, concentration, shown_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(promptId, user.user_id, topInterestId, interestRow?.label ?? topInterestId, concentration, now);
        balancePrompt = { promptId, interestId: topInterestId, interestLabel: interestRow?.label ?? topInterestId, concentration };
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
      interestId: c.interest_id,
      sourceType: c.source_type,
    })),
    coldStart,
    balancePrompt,
  });
});

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
