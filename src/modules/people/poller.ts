// RSS poller for followed channels. Owns per-channel dedup, the first-poll
// confirmation flow, and short filtering.
//
// ADR-0009: new follow uploads now enter the Candidate pool as
// `source_type = 'subscription'` (not the `requests` download path) so they
// run through the same scoring → guard → composition pipeline as everything
// else. The poll is a prerequisite step of the daily discovery job
// (`runRssPollPass`), not a standalone `setInterval` loop — that drift-prone
// 6-hour timer (re-anchored on every server restart) is retired.
//
// `seen_videos` stays purely the poller's "new upload" ledger: every windowed
// video is recorded so the next poll knows what's new. The back-catalogue
// seeder no longer dedups against it (it uses isDuplicateCandidate instead),
// so poll-first doesn't starve the back catalogue of a new follow's recent
// uploads.
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { SHORTS_MAX_SECS } from '../content';
import { recentUploads, videoDurations } from '../../discovery-metadata';
import { applyChannelInfoToPerson } from './registry';
import { getDeclaredChannelInterest } from '../interests';

// ── RSS parsing ───────────────────────────────────────────────────────────────

export interface RssVideo {
  videoId: string;
  title: string;
  publishedAt: string;
  thumbnailUrl: string | null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Exported for direct unit-testing of the parser's three observable
// properties (HTML-entity decoding, missing-thumbnail safety, entry
// ordering). Callers inside this module are the only production users.
export function parseYoutubeRss(xml: string): { channelName: string; videos: RssVideo[] } {
  const feedTitleMatch = /<feed[^>]*>[\s\S]*?<title>([^<]+)<\/title>/.exec(xml);
  const channelName = decodeHtmlEntities(feedTitleMatch?.[1]?.trim() ?? '');

  const videos: RssVideo[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry)?.[1]?.trim();
    const title = /<title>([^<]+)<\/title>/.exec(entry)?.[1]?.trim();
    const published = /<published>([^<]+)<\/published>/.exec(entry)?.[1]?.trim();
    const thumbUrl = /<media:thumbnail url="([^"]+)"/.exec(entry)?.[1];

    if (videoId) {
      videos.push({
        videoId,
        title: decodeHtmlEntities(title ?? ''),
        publishedAt: published ?? new Date().toISOString(),
        thumbnailUrl: thumbUrl ?? null,
      });
    }
  }

  return { channelName, videos };
}

// ── RSS poller ────────────────────────────────────────────────────────────────

// YouTube RSS doesn't carry duration, so we resolve it before queueing. Under
// the Data API the whole pass's new ids go in one batched videos.list (#193);
// yt-dlp still probes per video behind the same call. An id missing from the
// map is unknown duration and the caller proceeds — better to download the
// occasional short than to silently drop a followed creator's video because
// metadata wobbled. A Data API quota exhaustion is NOT a flake, though:
// swallowing it would disable Shorts filtering for the rest of the pass and
// flood the pool, so it propagates for the caller to stand the poll down (#194);
// a generic flake yields an empty map and every new video proceeds as unknown.
async function fetchDurations(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  try {
    return await videoDurations(ids);
  } catch (err) {
    if ((err as { quotaExceeded?: boolean }).quotaExceeded) throw err;
    logger.debug({ err }, 'Batched duration probe failed — proceeding unknown');
    return new Map();
  }
}

export interface OutputRow {
  output_id: string;
  channel_id: string;
  person_id: string;
  channel_name: string;
}

// A channel's newest uploads, or null when the listing could not be read (already
// logged). Under the Data API source this is one playlistItems.list call; the
// RSS feed is only the fallback source's listing, because it proved unreliable
// as the primary — whole 05:00 passes came back 404/500 for every channel, and
// an upload found days late has decayed below the slate's score floor. A quota
// stand-down is not a per-channel flake, so it propagates (#194).
async function listRecentUploads(channelId: string): Promise<RssVideo[] | null> {
  let viaApi: RssVideo[] | null;
  try {
    viaApi = await recentUploads(channelId);
  } catch (err) {
    if ((err as { quotaExceeded?: boolean }).quotaExceeded) throw err;
    logger.warn({ err, channelId }, 'Uploads listing failed');
    return null;
  }
  if (viaApi !== null) return viaApi;

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      logger.warn({ channelId, status: resp.status }, 'RSS fetch non-200');
      return null;
    }
    return parseYoutubeRss(await resp.text()).videos;
  } catch (err) {
    logger.warn({ err, channelId }, 'RSS fetch failed');
    return null;
  }
}

// Resolves true when the channel's uploads listing was read, false when it
// could not be — the pass tallies these so a wholesale failure is loud.
export async function pollChannel(output: OutputRow): Promise<boolean> {
  // Silent refresh of person bio + photo. Fire-and-forget — keeps poll latency
  // bounded by the listing + duration work, not by the channel-metadata call.
  void applyChannelInfoToPerson(output.person_id, output.channel_id)
    .catch((err: unknown) =>
      logger.debug({ err, channelId: output.channel_id }, 'Channel info refresh failed'),
    );

  const videos = await listRecentUploads(output.channel_id);
  if (videos === null) return false;

  const followers = db.prepare(
    'SELECT user_id FROM followed_people WHERE person_id = ?'
  ).all(output.person_id) as Array<{ user_id: string }>;

  if (followers.length === 0) return true;

  // On first poll for a channel (no seen_videos yet), queue only the latest
  // video as confirmation that follow worked. Mark the rest seen without downloading.
  const hasAnySeenVideos = !!db.prepare(
    'SELECT 1 FROM seen_videos WHERE channel_id = ? LIMIT 1'
  ).get(output.channel_id);
  const isFirstPoll = !hasAnySeenVideos;

  // Collect this channel's new uploads (RSS order) before any duration probe or
  // seen-marking, so the batch resolves in a single videos.list (#193) and a
  // quota stand-down leaves every one of them unseen to retry next pass — the
  // filter only reads seen_videos, it doesn't write.
  const unseen = videos.filter(
    (video) =>
      !db
        .prepare('SELECT 1 FROM seen_videos WHERE channel_id = ? AND video_id = ?')
        .get(output.channel_id, video.videoId),
  );

  // Resolve all the new durations up front. Throws (and unwinds the pass) only
  // on a quota stand-down; otherwise returns a map with a positive duration for
  // every id it could resolve, the rest absent.
  const durations = await fetchDurations(unseen.map((video) => video.videoId));

  let firstUnseen = true;

  for (const video of unseen) {
    // A map miss = unusable/unknown duration; treat as no-information and fall
    // through (shorts filter can't fire), exactly as the per-video null did.
    // Skip shorts before consuming the first-poll confirmation slot, so a
    // channel whose latest upload is a short still confirms with the next
    // non-short rather than queueing nothing.
    const duration = durations.get(video.videoId) ?? null;

    db.prepare(
      'INSERT OR IGNORE INTO seen_videos (channel_id, video_id, seen_at) VALUES (?, ?, ?)'
    ).run(output.channel_id, video.videoId, new Date().toISOString());
    if (duration !== null && duration <= SHORTS_MAX_SECS) {
      logger.info(
        { videoId: video.videoId, channelId: output.channel_id, duration },
        'Skipping short from follow'
      );
      continue;
    }

    // On first poll: seed only the single most recent (non-short) video as a
    // confirmation candidate; the rest stay marked seen but create no
    // candidate (the back-catalogue seeder mines those).
    if (isFirstPoll && !firstUnseen) continue;
    firstUnseen = false;

    const url = `https://www.youtube.com/watch?v=${video.videoId}`;

    for (const follower of followers) {
      // The channel's inferred interest (from inferChannelInterests at follow
      // time) gives the candidate an interest_id so scoring can name the
      // connection and the per-interest cap engages for follow-provenance
      // back-catalogue / delighter siblings. Mirrors seedBackCatalogCandidates.
      // Scoped per-follower to that user's declared interests: the global
      // channel_interest_links inference must not stamp another user's interest
      // onto this feed (e.g. a kid inheriting an adult's economics/philosophy).
      const interestId = getDeclaredChannelInterest(follower.user_id, output.channel_id);

      // Dedup against both the pool and requests: a video already a candidate
      // (e.g. seeded by the back catalogue) or already requested for this user
      // must not spawn a second subscription candidate.
      const inPool = db.prepare(
        'SELECT 1 FROM candidate_pool WHERE user_id = ? AND external_id = ? LIMIT 1'
      ).get(follower.user_id, video.videoId);
      if (inPool) continue;
      const inRequests = db.prepare(
        'SELECT 1 FROM requests WHERE user_id = ? AND youtube_id = ? LIMIT 1'
      ).get(follower.user_id, video.videoId);
      if (inRequests) continue;

      const candidateId = uuidv7();
      db.prepare(`
        INSERT OR IGNORE INTO candidate_pool
          (candidate_id, user_id, content_type, source_type, person_id, interest_id,
           url, external_id, title, channel, duration_secs, thumbnail_url,
           published_at, status, created_at)
        VALUES
          (?, ?, 'video', 'subscription', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        candidateId, follower.user_id, output.person_id, interestId,
        url, video.videoId, video.title || null,
        output.channel_name, duration,
        video.thumbnailUrl, video.publishedAt, nowIso(),
      );

      logger.info(
        { candidateId, videoId: video.videoId, userId: follower.user_id },
        'Subscription candidate created',
      );
    }
  }

  db.prepare('UPDATE person_outputs SET last_polled = ? WHERE output_id = ?')
    .run(nowIso(), output.output_id);
  return true;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Full poll pass over every active, followed YouTube channel. The daily
// discovery job awaits this as its first step (ADR-0009) so subscription
// candidates are in the pool before composition runs. Per-channel failures
// are logged and skipped — one flaky listing must not abort the pass — but a
// pass in which NO channel could be read is an error, not a quiet day: that is
// how weeks of failed polls went unnoticed.
export async function runRssPollPass(): Promise<void> {
  const outputs = db.prepare(`
    SELECT DISTINCT po.output_id, po.external_id AS channel_id, po.person_id,
                    p.display_name AS channel_name
    FROM person_outputs po
    INNER JOIN people p ON p.person_id = po.person_id
    INNER JOIN followed_people fp ON fp.person_id = po.person_id
    WHERE po.output_type = 'youtube' AND po.active = 1
  `).all() as OutputRow[];

  if (outputs.length === 0) return;

  logger.info({ count: outputs.length }, 'RSS poll pass starting');

  let failed = 0;
  let aborted = false;

  for (const output of outputs) {
    try {
      if (!(await pollChannel(output))) failed += 1;
    } catch (err) {
      // Data API quota exhaustion (#194): the next channel's probes hit the
      // same wall, so abort the whole pass rather than burn a failed call per
      // remaining channel. No fallback to yt-dlp scraping, by design.
      if ((err as { quotaExceeded?: boolean }).quotaExceeded) {
        logger.warn(
          { channelId: output.channel_id },
          'RSS poll pass: YouTube Data API quota exhausted — aborting remaining channels',
        );
        aborted = true;
        break;
      }
      failed += 1;
      logger.error({ err, channelId: output.channel_id }, 'RSS poll failed for channel');
    }
  }

  if (!aborted && failed === outputs.length) {
    logger.error(
      { count: outputs.length },
      'RSS poll pass: every channel failed — no follow uploads were read today',
    );
  }

  logger.info({ count: outputs.length, failed }, 'RSS poll pass complete');
}
