import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response, NextFunction } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError, NotFoundError } from '../../errors';
import { downloadQueue } from '../../queue';
import type { DownloadJobData } from '../content';

const execFileAsync = promisify(execFile);

// YTDLP_BIN points to the Ubuntu worker path; M4 channel search needs a separate var.
// Default to the Homebrew path which is where yt-dlp lives on the M4.
const YTDLP_BIN_M4 = process.env['YTDLP_BIN_M4'] ?? '/opt/homebrew/bin/yt-dlp';
const NODE_BIN = process.env['NODE_BIN'] ?? 'node';
const RSS_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

function baseArgs(): string[] {
  return [
    '--js-runtimes', `node:${NODE_BIN}`,
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=mweb',
  ];
}

// ── Channel search ────────────────────────────────────────────────────────────

export interface ChannelResult {
  channelId: string;
  channelName: string;
  channelUrl: string;
}

export async function searchYoutubeChannels(query: string): Promise<ChannelResult[]> {
  // Search doesn't need the mweb/PO-token/remote-components stack — that's for video downloads.
  // Plain yt-dlp ytsearch works without auth for metadata-only queries.
  const { stdout } = await execFileAsync(YTDLP_BIN_M4, [
    `ytsearch10:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-download',
    '--quiet',
  ], { maxBuffer: 5 * 1024 * 1024, timeout: 20_000 });

  const seen = new Set<string>();
  const results: ChannelResult[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      const channelId = item['channel_id'] as string | undefined;
      if (!channelId || seen.has(channelId)) continue;
      seen.add(channelId);
      results.push({
        channelId,
        channelName: String(item['channel'] ?? item['uploader'] ?? ''),
        channelUrl: String(item['uploader_url'] ?? `https://www.youtube.com/channel/${channelId}`),
      });
    } catch {
      // skip malformed lines
    }
  }

  return results;
}

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

interface OutputRow {
  output_id: string;
  channel_id: string;
  person_id: string;
  channel_name: string;
}

async function pollChannel(output: OutputRow): Promise<void> {
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

    // On first poll: skip downloading all but the single most recent video
    if (isFirstPoll && !firstUnseen) continue;
    firstUnseen = false;

    const url = `https://www.youtube.com/watch?v=${video.videoId}`;

    for (const follower of followers) {
      const exists = db.prepare(
        'SELECT 1 FROM requests WHERE user_id = ? AND youtube_id = ?'
      ).get(follower.user_id, video.videoId);
      if (exists) continue;

      const requestId = uuidv7();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO requests
          (request_id, user_id, source, url, youtube_id, title, channel, status, requested_at, added_at, file_state)
        VALUES
          (@requestId, @userId, 'channel_subscription', @url, @youtubeId, @title, @channel,
           'pending', @now, @now, 'live')
      `).run({
        requestId,
        userId: follower.user_id,
        url,
        youtubeId: video.videoId,
        title: video.title,
        channel: output.channel_name,
        now,
      });

      const jobData: DownloadJobData = { requestId, youtubeId: video.videoId, url };
      await downloadQueue.add('download', jobData, { jobId: requestId });

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

// ── HTTP router ───────────────────────────────────────────────────────────────

export const peopleRouter = Router();

// Express 4 doesn't catch rejected promises from async handlers — wrap them.
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function ra(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function resolveUserId(userId?: string): string {
  if (!userId) throw new ValidationError('userId required');
  const found = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId) as { user_id: string } | undefined;
  if (!found) throw new NotFoundError(`user ${userId}`);
  return found.user_id;
}

// GET /people/search?q=&userId=
peopleRouter.get('/search', ra(async (req, res) => {
  const { q, userId } = req.query as { q?: string; userId?: string };
  if (!q?.trim()) throw new ValidationError('q required');
  const uid = resolveUserId(userId);

  let channels: ChannelResult[];
  let searchError = false;
  try {
    channels = await searchYoutubeChannels(q.trim());
  } catch (err) {
    logger.error({ err, ytdlpBin: YTDLP_BIN_M4 }, 'Channel search failed');
    channels = [];
    searchError = true;
  }

  const followingIds = new Set(
    (db.prepare('SELECT po.external_id FROM followed_people fp INNER JOIN person_outputs po ON po.person_id = fp.person_id WHERE fp.user_id = ? AND po.output_type = ?').all(uid, 'youtube') as Array<{ external_id: string }>)
      .map((r) => r.external_id)
  );

  const results = channels.map((c) => ({ ...c, following: followingIds.has(c.channelId) }));
  res.json({ channels: results, searchError });
}));

// GET /people/following?userId=
peopleRouter.get('/following', (req: Request, res: Response) => {
  const { userId } = req.query as { userId?: string };
  const uid = resolveUserId(userId);

  const rows = db.prepare(`
    SELECT p.person_id, p.display_name, p.person_type, p.photo_url,
           po.output_id, po.external_id AS channel_id, po.feed_url, po.last_polled,
           fp.followed_at
    FROM followed_people fp
    INNER JOIN people p ON p.person_id = fp.person_id
    LEFT JOIN person_outputs po ON po.person_id = fp.person_id AND po.output_type = 'youtube'
    WHERE fp.user_id = ?
    ORDER BY fp.followed_at DESC
  `).all(uid);

  res.json({ following: rows });
});

// POST /people/follow — body: { userId, channelId, channelName, channelUrl }
peopleRouter.post('/follow', (req: Request, res: Response) => {
  const { userId, channelId, channelName } = req.body as {
    userId?: string; channelId?: string; channelName?: string; channelUrl?: string;
  };
  if (!channelId?.trim()) throw new ValidationError('channelId required');
  if (!channelName?.trim()) throw new ValidationError('channelName required');
  const uid = resolveUserId(userId);

  // Find or create person + output by channel_id
  const existingOutput = db.prepare(
    'SELECT person_id, output_id FROM person_outputs WHERE output_type = ? AND external_id = ?'
  ).get('youtube', channelId) as { person_id: string; output_id: string } | undefined;

  let personId: string;
  let outputId: string;
  if (existingOutput) {
    personId = existingOutput.person_id;
    outputId = existingOutput.output_id;
  } else {
    personId = uuidv7();
    outputId = uuidv7();
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO people (person_id, display_name, person_type, created_at)
      VALUES (?, ?, 'individual', ?)
    `).run(personId, channelName.trim(), now);

    db.prepare(`
      INSERT INTO person_outputs (output_id, person_id, output_type, fetcher_type, feed_url, external_id, active)
      VALUES (?, ?, 'youtube', 'youtube-rss', ?, ?, 1)
    `).run(outputId, personId, feedUrl, channelId);
  }

  // Upsert follow
  const alreadyFollowing = db.prepare(
    'SELECT 1 FROM followed_people WHERE user_id = ? AND person_id = ?'
  ).get(uid, personId);

  if (!alreadyFollowing) {
    db.prepare(`
      INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
      VALUES (?, ?, 1.0, ?, 'manual')
    `).run(uid, personId, new Date().toISOString());
  }

  // Fire-and-forget: poll the channel immediately so videos appear without waiting for the poller
  void pollChannel({ output_id: outputId, channel_id: channelId, person_id: personId, channel_name: channelName.trim() })
    .catch((err: unknown) => logger.error({ err, channelId }, 'Immediate post-follow poll failed'));

  logger.info({ userId: uid, personId, channelId }, 'User followed channel');
  res.json({ personId, channelId, following: true });
});

// DELETE /people/follow/:channelId?userId=
peopleRouter.delete('/follow/:channelId', (req: Request, res: Response) => {
  const { channelId } = req.params as { channelId: string };
  const { userId } = req.query as { userId?: string };
  const uid = resolveUserId(userId);

  const output = db.prepare(
    'SELECT person_id FROM person_outputs WHERE output_type = ? AND external_id = ?'
  ).get('youtube', channelId) as { person_id: string } | undefined;

  if (!output) throw new NotFoundError(`channel ${channelId}`);

  db.prepare('DELETE FROM followed_people WHERE user_id = ? AND person_id = ?')
    .run(uid, output.person_id);

  logger.info({ userId: uid, channelId }, 'User unfollowed channel');
  res.json({ channelId, following: false });
});
