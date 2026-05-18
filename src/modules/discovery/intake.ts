import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { SHORTS_MAX_SECS } from '../content';
import {
  searchVideosWithDates,
  flatPlaylistChannel,
  type SearchVideoWithDate,
  type PlaylistEntry,
} from '../../ytdlp';
import { daysSince, uploadDateToIso } from './util';

export interface UserInterestRow {
  interest_id: string;
  label: string;
  rank: number;
  expertise: 'beginner' | 'comfortable' | 'deep';
  search_terms: string;
}

// Freshness window at intake. Older content is dropped before it ever
// reaches scoring. Set generous so the pool has volume — surfacing applies
// a per-day decay (1.6× for <24h down to 0.4× for >90 days) so fresh wins
// on ranking even when older items are present.
const FRESHNESS_WINDOW_DAYS = 180;

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

// Per-user channel dismissal counts, keyed by free-text channel name as
// reported by yt-dlp. Counts the *distinct videos* the user has rejected on
// a given channel, summed across both pre-play swipe-dismisses
// (candidate_pool.status='dismissed') and player-side deletes
// (requests.status='deleted'). Aggregation is source-agnostic on purpose —
// the act of rejecting is the signal, regardless of how the video arrived
// (interest search, follow back-catalog, share-sheet, etc.). See issue #147.
//
// Computed once per refreshCandidatePool call and held in memory for the
// duration of the loop — cheaper than a per-candidate SELECT, and the table
// can't change underneath us inside one synchronous tick.
function loadChannelDismissalCounts(userId: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT channel, COUNT(*) AS n FROM (
      SELECT DISTINCT external_id AS video_id, channel
      FROM candidate_pool
      WHERE user_id = ?
        AND status = 'dismissed'
        AND channel IS NOT NULL
        AND channel <> ''
        AND external_id IS NOT NULL
      UNION
      SELECT DISTINCT youtube_id AS video_id, channel
      FROM requests
      WHERE user_id = ?
        AND status = 'deleted'
        AND channel IS NOT NULL
        AND channel <> ''
        AND youtube_id IS NOT NULL
    )
    GROUP BY channel
  `).all(userId, userId) as Array<{ channel: string; n: number }>;

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.channel, r.n);
  return map;
}

// Brief §17, issue #149: person-sourced material is the primary discovery
// signal; interest search is the gap-filler. Counts the live person-sourced
// supply available to fill *this refresh's* slate:
//
//   - candidate_pool rows with source_type ∈ {person_backcatalog,
//     person_recommendation} that are still eligible candidates — status
//     ∈ {pending, scored} and created in the last 24h. Other statuses
//     don't count as supply for this slate: `dismissed` / `guard_rejected`
//     were rejected; `requested` / `surfaced` were already spent (the
//     first is on the feed, the second was a previous refresh's pick);
//     `guard_pending` rows are stuck for kid users (surfaceForToday only
//     reads `status='scored'`, never `guard_pending`) so counting them
//     overstates the kid's effective supply. The 24h created_at floor
//     stops historical `pending` / `scored` rows that lingered past
//     pruning from making the supply look healthy when nothing fresh
//     arrived this refresh.
//   - requests with source='channel_subscription' added in the last 24h
//     that are visible on the feed — RSS-poller landings from followed
//     people. Those bypass the candidate pool entirely (poll → requests
//     directly) but they're person-sourced material on the user's feed,
//     so they count toward "is the person supply thin?". 24h tracks the
//     daily discovery cadence. The status filter matches the feed query
//     in modules/requests (status NOT IN dismissed/deleted, and
//     channel_subscription rows in pending/downloading are still hidden
//     pending download completion), so we don't count rows the user
//     can't see.
//
// Used by refreshCandidatePool to decide skip / partial / full interest
// search. Exported for tests.
export function countPersonSourcedForRefresh(userId: string): number {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const pool = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ?
      AND source_type IN ('person_backcatalog', 'person_recommendation')
      AND status IN ('pending', 'scored')
      AND created_at >= ?
  `).get(userId, since) as { n: number };

  const reqs = db.prepare(`
    SELECT COUNT(*) AS n FROM requests
    WHERE user_id = ?
      AND source = 'channel_subscription'
      AND requested_at >= ?
      AND status NOT IN ('dismissed', 'deleted', 'pending', 'downloading')
  `).get(userId, since) as { n: number };

  return pool.n + reqs.n;
}

export interface RefreshOptions {
  // Number of person-sourced candidates already populated for this user this
  // refresh. When the threshold is positive and personSourcedCount meets or
  // exceeds it, interest search is skipped entirely. When below threshold,
  // the search runs with a proportionally reduced query budget.
  personSourcedCount: number;
  // 0 disables gating (always run at full budget). Otherwise the daily-slate
  // cap for the user role (adult 15 / kid 5 by default).
  threshold: number;
}

// Build the ordered list of (interest, term) pairs the search loop would run
// at full budget — top 3 interests contribute their first two terms, ranks
// 4–10 contribute one. Worst-case length is 13 (3×2 + 7×1). Returned as a
// flat array so a deficit-scaled budget can simply slice the prefix.
function planInterestQueries(userInterests: UserInterestRow[]): Array<{ interest: UserInterestRow; term: string }> {
  const plan: Array<{ interest: UserInterestRow; term: string }> = [];
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
      plan.push({ interest, term });
    }
  }
  return plan;
}

export async function refreshCandidatePool(
  userId: string,
  userInterests: UserInterestRow[],
  options: RefreshOptions,
): Promise<number> {
  const now = new Date().toISOString();
  let added = 0;

  // Channel-level dismissal filter (issue #147). A threshold of 0 disables
  // the filter entirely so the prefetch is skipped when not configured.
  const channelDismissThreshold = config.DISCOVERY_CHANNEL_DISMISS_THRESHOLD;
  const channelDismissals = channelDismissThreshold > 0
    ? loadChannelDismissalCounts(userId)
    : null;

  // Brief §17 gating (issue #149). Build the full plan, then pick a prefix
  // sized to the deficit so top-ranked interests always win the reduced
  // budget. The plan preserves the historical ordering: interest1 t0,
  // interest1 t1, interest2 t0, interest2 t1, ..., interest10 t0.
  const fullPlan = planInterestQueries(userInterests);
  const fullBudget = fullPlan.length;
  const { personSourcedCount, threshold } = options;

  let queriesPlanned: number;
  let action: 'skip' | 'partial' | 'full';
  if (threshold <= 0) {
    // Gating disabled — original behaviour, full budget every refresh.
    queriesPlanned = fullBudget;
    action = 'full';
  } else if (personSourcedCount >= threshold) {
    queriesPlanned = 0;
    action = 'skip';
  } else if (personSourcedCount <= 0) {
    queriesPlanned = fullBudget;
    action = 'full';
  } else {
    // Scale by deficit ratio. A 2-item shortfall against a 15 threshold
    // should not pull 13 queries — round up so a single missing item still
    // gets at least one query attempt.
    const deficit = threshold - personSourcedCount;
    queriesPlanned = Math.min(fullBudget, Math.ceil((fullBudget * deficit) / threshold));
    action = 'partial';
  }

  logger.info(
    {
      userId,
      person_count: personSourcedCount,
      threshold,
      action,
      interest_queries_planned: queriesPlanned,
    },
    'Discovery intake: interest-search gating decision',
  );

  if (queriesPlanned === 0) return 0;

  const plan = fullPlan.slice(0, queriesPlanned);

  for (const { interest, term } of plan) {
    let results: SearchVideoWithDate[];
    try {
      results = await searchVideosWithDates(term);
    } catch (err) {
      logger.warn({ err, searchTerm: term }, 'Discovery: yt-dlp search failed');
      continue;
    }

    for (const result of results) {
      if (isDuplicateCandidate(userId, result.videoId)) continue;
      if (result.durationSecs !== null && result.durationSecs <= SHORTS_MAX_SECS) continue;
      if (result.liveStatus === 'is_live' || result.liveStatus === 'is_upcoming') continue;

      // Channel-level dismissal cap: skip candidates from channels the user
      // has rejected at or above the configured threshold. Channels without
      // a name (yt-dlp returned empty) bypass the filter — we'd be matching
      // every empty-channel candidate together otherwise.
      if (channelDismissals && result.channel) {
        const dismissCount = channelDismissals.get(result.channel) ?? 0;
        if (dismissCount >= channelDismissThreshold) {
          logger.info(
            {
              userId,
              channel: result.channel,
              videoId: result.videoId,
              dismissCount,
              threshold: channelDismissThreshold,
            },
            'Discovery intake: filtered candidate from over-dismissed channel',
          );
          continue;
        }
      }

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

const PER_CHANNEL_BACKCATALOG_BUDGET = 3;
const MAX_BACKCATALOG_PER_USER = 20;

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export async function seedBackCatalogCandidates(userId: string): Promise<number> {
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

    let playlist: PlaylistEntry[];
    try {
      playlist = await flatPlaylistChannel(output.channel_id);
    } catch (err) {
      logger.warn({ err, channelId: output.channel_id }, 'Back-catalog: flat-playlist fetch failed');
      continue;
    }
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
