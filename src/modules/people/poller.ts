// RSS poller for followed channels. Owns the 6-hour poll loop, per-channel
// dedup, first-poll confirmation flow, and short filtering. Deep-imports
// `createFromChannelPoll` from `../requests/state-default` (a one-way edge
// now that `./registry` was extracted to break the requests↔people cycle)
// to keep the poller's module graph free of the requests HTTP router. The
// shim still pulls in BullMQ/ntfy transitively — `state-default.ts` is the
// production-wiring surface; the pure state machine lives in `./state.ts`.
import { db } from '../../db/client';
import { logger } from '../../logger';
import { SHORTS_MAX_SECS } from '../content';
import { createFromChannelPoll } from '../requests/state-default';
import { videoDuration } from '../../ytdlp';
import { applyChannelInfoToPerson } from './registry';

const RSS_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── RSS parsing ───────────────────────────────────────────────────────────────

interface RssVideo {
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

function parseYoutubeRss(xml: string): { channelName: string; videos: RssVideo[] } {
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

    // On first poll: skip downloading all but the single most recent video
    if (isFirstPoll && !firstUnseen) continue;
    firstUnseen = false;

    const url = `https://www.youtube.com/watch?v=${video.videoId}`;

    for (const follower of followers) {
      const exists = db.prepare(
        'SELECT 1 FROM requests WHERE user_id = ? AND youtube_id = ?'
      ).get(follower.user_id, video.videoId);
      if (exists) continue;

      const { requestId } = await createFromChannelPoll({
        url,
        userId: follower.user_id,
        youtubeId: video.videoId,
        youtubeChannelId: output.channel_id,
        title: video.title,
        channel: output.channel_name,
      });

      logger.info({ requestId, videoId: video.videoId, userId: follower.user_id }, 'Channel subscription request created');
    }
  }

  db.prepare('UPDATE person_outputs SET last_polled = ? WHERE output_id = ?')
    .run(new Date().toISOString(), output.output_id);
}

async function runRssPoll(): Promise<void> {
  const outputs = db.prepare(`
    SELECT DISTINCT po.output_id, po.external_id AS channel_id, po.person_id,
                    p.display_name AS channel_name
    FROM person_outputs po
    INNER JOIN people p ON p.person_id = po.person_id
    INNER JOIN followed_people fp ON fp.person_id = po.person_id
    WHERE po.output_type = 'youtube' AND po.active = 1
  `).all() as OutputRow[];

  if (outputs.length === 0) return;

  logger.info({ count: outputs.length }, 'RSS poll starting');

  for (const output of outputs) {
    await pollChannel(output).catch((err: unknown) => {
      logger.error({ err, channelId: output.channel_id }, 'RSS poll failed for channel');
    });
  }

  logger.info({ count: outputs.length }, 'RSS poll complete');
}

let pollerTimer: ReturnType<typeof setInterval> | null = null;

export function startRssPoller(): void {
  if (pollerTimer) return;
  logger.info({ intervalHours: 6 }, 'RSS poller started');
  pollerTimer = setInterval(() => {
    void runRssPoll().catch((err: unknown) => {
      logger.error({ err }, 'RSS poll cycle failed');
    });
  }, RSS_POLL_INTERVAL_MS);
  setTimeout(() => {
    void runRssPoll().catch((err: unknown) => {
      logger.error({ err }, 'RSS poll startup run failed');
    });
  }, 60_000);
}

export function stopRssPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}
