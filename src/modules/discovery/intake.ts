import { execFile } from 'child_process';
import { promisify } from 'util';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { SHORTS_MAX_SECS } from '../content';
import { daysSince, uploadDateToIso } from './util';

const execFileAsync = promisify(execFile);
const YTDLP_BIN_M4 = process.env['YTDLP_BIN_M4'] ?? '/opt/homebrew/bin/yt-dlp';

export interface UserInterestRow {
  interest_id: string;
  label: string;
  rank: number;
  expertise: 'beginner' | 'comfortable' | 'deep';
  search_terms: string;
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

// Freshness window at intake. Older content is dropped before it ever
// reaches scoring. Set generous so the pool has volume — surfacing applies
// a per-day decay (1.6× for <24h down to 0.4× for >90 days) so fresh wins
// on ranking even when older items are present.
const FRESHNESS_WINDOW_DAYS = 180;

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

export async function refreshCandidatePool(userId: string, userInterests: UserInterestRow[]): Promise<number> {
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
