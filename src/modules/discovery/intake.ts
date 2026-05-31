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
import { getDeclaredChannelInterest } from '../interests';
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

// Build the ordered list of (interest, term) pairs the search loop runs:
// top 3 interests contribute their first two terms, ranks 4–10 contribute
// one. Worst-case length is 13 (3×2 + 7×1).
//
// ADR-0009: interest search no longer gates on person-sourced supply — it
// always runs at full budget to fill the delighter bucket. The #149 gate
// (skip / partial / full based on a person-sourced count) is gone.
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

// Interest search supplies the delighter bucket (ADR-0009). Always runs at
// full budget — no person-sourced gating.
export async function refreshCandidatePool(
  userId: string,
  userInterests: UserInterestRow[],
): Promise<number> {
  const now = new Date().toISOString();
  let added = 0;

  // Channel-level dismissal filter (issue #147). A threshold of 0 disables
  // the filter entirely so the prefetch is skipped when not configured.
  const channelDismissThreshold = config.DISCOVERY_CHANNEL_DISMISS_THRESHOLD;
  const channelDismissals = channelDismissThreshold > 0
    ? loadChannelDismissalCounts(userId)
    : null;

  const plan = planInterestQueries(userInterests);

  logger.info(
    { userId, interest_queries_planned: plan.length },
    'Discovery intake: interest-search budget',
  );

  if (plan.length === 0) return 0;

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
// New followed-channel uploads now enter the candidate pool as
// `source_type = 'subscription'` via the RSS poller (modules/people, ADR-0009),
// so they run through scoring + guard + composition like everything else. The
// back catalogue of a creator a kid just started following is still invisible
// to discovery unless we deliberately mine it.
//
// `seedBackCatalogCandidates` does that: pulls a flat playlist for each
// followed YouTube output, removes anything already a candidate/request
// (isDuplicateCandidate — NOT seen_videos, see the filter below), samples a
// small budget per channel, and inserts those into the candidate pool with
// `source_type = 'person_backcatalog'`. From there they run through the same
// scoring, guard, and surfacing pipeline as interest-search candidates — they
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

    // Dedup against the pool + requests (isDuplicateCandidate), NOT seen_videos
    // (ADR-0009). The discovery job polls first, and the poller writes every
    // RSS-window video into seen_videos as its "new upload" ledger — so
    // excluding seen_videos here would starve the back catalogue of a new
    // follow's recent uploads (exactly the ones a kid most wants to see).
    // isDuplicateCandidate still stops a video the poller turned into a
    // subscription candidate this run from being re-added as back-catalogue.
    const eligible = playlist.filter((v) => {
      if (v.durationSecs !== null && v.durationSecs <= SHORTS_MAX_SECS) return false;
      if (v.liveStatus === 'is_live' || v.liveStatus === 'is_upcoming') return false;
      if (isDuplicateCandidate(userId, v.videoId)) return false;
      return true;
    });

    if (eligible.length === 0) continue;

    // Channel→interest mapping (from inferChannelInterests at follow time)
    // gives the candidate an interest_id, so the per-interest cap engages
    // and rank-weighted surfacing works the same way as interest-search.
    // Scoped to this user's declared interests so the global, all-users
    // channel_interest_links inference can't stamp another user's interest
    // onto this feed (e.g. a kid inheriting an adult's economics/philosophy).
    const interestId = getDeclaredChannelInterest(userId, output.channel_id);

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
