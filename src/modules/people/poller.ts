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
import { videoDuration } from '../../ytdlp';
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

// YouTube RSS doesn't carry duration, so we probe with yt-dlp before
// queueing. On failure we return null and let the caller proceed —
// better to download the occasional short than to silently drop a
// followed creator's video because metadata flaked.
async function fetchVideoDuration(videoId: string): Promise<number | null> {
  try {
    return await videoDuration(videoId);
  } catch {
    return null;
  }
}

export interface OutputRow {
  output_id: string;
  channel_id: string;
  person_id: string;
  channel_name: string;
}

export async function pollChannel(output: OutputRow): Promise<void> {
  // Silent refresh of person bio + photo. Fire-and-forget — keeps poll latency
  // bounded by RSS+yt-dlp(video) work, not by the channel-metadata call.
  void applyChannelInfoToPerson(output.person_id, output.channel_id)
    .catch((err: unknown) =>
      logger.debug({ err, channelId: output.channel_id }, 'Channel info refresh failed'),
    );

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${output.channel_id}`;

  let xml: string;
  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      logger.warn({ channelId: output.channel_id, status: resp.status }, 'RSS fetch non-200');
      return;
    }
    xml = await resp.text();
  } catch (err) {
    logger.warn({ err, channelId: output.channel_id }, 'RSS fetch failed');
    return;
  }

  const { videos } = parseYoutubeRss(xml);

  const followers = db.prepare(
    'SELECT user_id FROM followed_people WHERE person_id = ?'
  ).all(output.person_id) as Array<{ user_id: string }>;

  if (followers.length === 0) return;

  // On first poll for a channel (no seen_videos yet), queue only the latest
  // video as confirmation that follow worked. Mark the rest seen without downloading.
  const hasAnySeenVideos = !!db.prepare(
    'SELECT 1 FROM seen_videos WHERE channel_id = ? LIMIT 1'
  ).get(output.channel_id);
  const isFirstPoll = !hasAnySeenVideos;

  let firstUnseen = true;

  for (const video of videos) {
    const alreadySeen = db.prepare(
      'SELECT 1 FROM seen_videos WHERE channel_id = ? AND video_id = ?'
    ).get(output.channel_id, video.videoId);

    if (alreadySeen) continue;

    db.prepare(
      'INSERT OR IGNORE INTO seen_videos (channel_id, video_id, seen_at) VALUES (?, ?, ?)'
    ).run(output.channel_id, video.videoId, new Date().toISOString());

    // Skip shorts before consuming the first-poll confirmation slot, so
    // a channel whose latest upload is a short still confirms with the
    // next non-short rather than queueing nothing.
    const duration = await fetchVideoDuration(video.videoId);
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
}

function nowIso(): string {
  return new Date().toISOString();
}

// Full poll pass over every active, followed YouTube channel. The daily
// discovery job awaits this as its first step (ADR-0009) so subscription
// candidates are in the pool before composition runs. Per-channel failures
// are logged and skipped — one flaky RSS feed must not abort the pass.
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

  for (const output of outputs) {
    await pollChannel(output).catch((err: unknown) => {
      logger.error({ err, channelId: output.channel_id }, 'RSS poll failed for channel');
    });
  }

  logger.info({ count: outputs.length }, 'RSS poll pass complete');
}
