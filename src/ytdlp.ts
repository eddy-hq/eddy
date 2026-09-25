// Adapter for anonymous yt-dlp metadata calls from the M4. Mirrors src/ollama.ts
// — flat top-level file, owns no DB/jobs/routes. Authenticated download path
// (worker, mweb client + PO-token stack) lives in src/modules/content/download.ts
// and stays separate; the seam is auth-vs-anonymous, not M4-vs-worker.
//
// All five functions throw YtdlpError on failure. Callers that want
// "treat failure as empty" must wrap with try/catch — we don't conflate
// "no results" with "search broke".
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from './config';
import { shouldEngageCooldown } from './botdetect';
import { ipStackArgs } from './ytdlp-ipstack';

const execFileAsync = promisify(execFile);

// Prepended to every spawn below so the anonymous M4 path shares one IP-stack
// reputation bucket with the worker download path (#185 follow-on).
const IP_STACK_ARGS = ipStackArgs(config.YTDLP_IP_STACK);

export class YtdlpError extends Error {
  // Set when the failure carries a throttle signal — YouTube's bot-detection
  // challenge OR a 429 rate-limit (in the message or the underlying spawn
  // error's stderr). Callers use it to engage the IP-wide cooldown (#185) and
  // stop fanning out further searches. Named botDetection for history; it means
  // "should stand down" (see shouldEngageCooldown).
  public readonly botDetection: boolean;
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'YtdlpError';
    const causeStderr = (cause as { stderr?: string } | undefined)?.stderr;
    this.botDetection = shouldEngageCooldown(message) || shouldEngageCooldown(causeStderr);
  }
}

export interface SearchVideoWithDate {
  videoId: string;
  title: string;
  channel: string;
  // YouTube channel id (UC...); '' when the source didn't report one.
  channelId: string;
  durationSecs: number | null;
  viewCount: number | null;
  uploadDate: string | null;
  thumbnailUrl: string | null;
  liveStatus: string | null;
  url: string;
}

export interface SearchVideoFlat {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  durationSecs: number | null;
  thumbnailUrl: string | null;
  url: string;
}

export interface SearchChannel {
  channelId: string;
  channelName: string;
  channelUrl: string;
}

// What a parent can point the block-channel CLI at, once parsed.
export type ChannelLookup =
  | { kind: 'channel_id'; channelId: string }
  | { kind: 'handle'; handle: string }
  | { kind: 'username'; username: string }
  | { kind: 'video'; videoId: string };

export interface ChannelIdentity {
  channelId: string;
  displayName: string;
}

export interface PlaylistEntry {
  videoId: string;
  title: string;
  durationSecs: number | null;
  liveStatus: string | null;
}

export interface ChannelInfo {
  description: string | null;
  avatarUrl: string | null;
}

interface RunOptions {
  timeoutMs: number;
  maxBufferMb: number;
}

// Parses yt-dlp's line-delimited JSON output: skips empty lines and
// JSON.parse failures (yt-dlp occasionally emits warning text through the
// print stream). Exported for tests; runYtdlpLines is the only runtime caller.
// Records missing `id` are kept here — per-function projection drops them.
export function parseYtdlpLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip malformed
    }
  }
  return records;
}

// Private spawn helper — owns process execution, timeout/buffer handling,
// and delegates parsing to parseYtdlpLines. yt-dlp flags (--no-download,
// --quiet, etc.) stay at the call site because they vary per command.
async function runYtdlpLines(
  args: string[],
  { timeoutMs, maxBufferMb }: RunOptions,
): Promise<Record<string, unknown>[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(config.YTDLP_BIN_M4, [...IP_STACK_ARGS, ...args], {
      maxBuffer: maxBufferMb * 1024 * 1024,
      timeout: timeoutMs,
    });
    stdout = result.stdout;
  } catch (err) {
    throw new YtdlpError(`yt-dlp invocation failed: ${(err as Error).message}`, err);
  }
  return parseYtdlpLines(stdout);
}

// `--print` template (slow, but `--flat-playlist` never returns upload_date,
// and freshness ranking depends on real dates).
export async function searchVideosWithDates(
  query: string,
  limit = 20,
): Promise<SearchVideoWithDate[]> {
  // --ignore-errors: a single unavailable video in the search result was
  // killing the whole batch (yt-dlp exits non-zero, execFile throws,
  // runYtdlpLines discards the 19 valid records). Tolerate per-video
  // failures and harvest whatever metadata yt-dlp could fetch.
  const records = await runYtdlpLines(
    [
      `ytsearch${limit}:${query}`,
      '--print',
      '%(.{id,title,channel,channel_id,duration,view_count,upload_date,timestamp,thumbnail,live_status})j',
      '--no-download',
      '--quiet',
      '--no-warnings',
      '--ignore-errors',
    ],
    { timeoutMs: 90_000, maxBufferMb: 10 },
  );

  const out: SearchVideoWithDate[] = [];
  for (const item of records) {
    const videoId = item['id'] as string | undefined;
    if (!videoId) continue;
    out.push({
      videoId,
      title: String(item['title'] ?? ''),
      channel: String(item['channel'] ?? ''),
      channelId: String(item['channel_id'] ?? ''),
      durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
      viewCount: typeof item['view_count'] === 'number' ? item['view_count'] : null,
      uploadDate: typeof item['upload_date'] === 'string' ? item['upload_date'] : null,
      thumbnailUrl: typeof item['thumbnail'] === 'string' ? item['thumbnail'] : null,
      liveStatus: typeof item['live_status'] === 'string' ? item['live_status'] : null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

// Flat-playlist + dump-json — faster than `--print`, exposes `thumbnails[]`
// and `channel_id`. Used by the search-videos route. Picks a thumbnail with
// height ≥ 180 if available, else falls back to the first.
export async function searchVideosFlat(
  query: string,
  limit = 10,
): Promise<SearchVideoFlat[]> {
  const records = await runYtdlpLines(
    [
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '--dump-json',
      '--no-download',
      '--quiet',
    ],
    { timeoutMs: 20_000, maxBufferMb: 5 },
  );

  const out: SearchVideoFlat[] = [];
  for (const item of records) {
    const videoId = item['id'] as string | undefined;
    if (!videoId) continue;
    const thumbs = (item['thumbnails'] as Array<{ url: string; height?: number }> | undefined) ?? [];
    const thumb = thumbs.find((t) => t.height && t.height >= 180) ?? thumbs[0];
    out.push({
      videoId,
      title: String(item['title'] ?? ''),
      channel: String(item['channel'] ?? item['uploader'] ?? ''),
      channelId: String(item['channel_id'] ?? ''),
      durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
      thumbnailUrl: thumb?.url ?? null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

// Same flat-playlist flow as searchVideosFlat but projects to channel
// records and de-duplicates by channel_id.
export async function searchChannelsFlat(
  query: string,
  limit = 10,
): Promise<SearchChannel[]> {
  const records = await runYtdlpLines(
    [
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '--dump-json',
      '--no-download',
      '--quiet',
    ],
    { timeoutMs: 20_000, maxBufferMb: 5 },
  );

  const seen = new Set<string>();
  const out: SearchChannel[] = [];
  for (const item of records) {
    const channelId = item['channel_id'] as string | undefined;
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    out.push({
      channelId,
      channelName: String(item['channel'] ?? item['uploader'] ?? ''),
      channelUrl: String(item['uploader_url'] ?? `https://www.youtube.com/channel/${channelId}`),
    });
  }
  return out;
}

// Channel-level metadata (description + avatar). Uses --playlist-items 0 so
// yt-dlp emits the playlist root JSON without enumerating any videos. Picks
// the largest available avatar by height.
export async function channelInfo(channelId: string): Promise<ChannelInfo> {
  const records = await runYtdlpLines(
    [
      `https://www.youtube.com/channel/${channelId}`,
      '--dump-single-json',
      '--playlist-items', '0',
      '--no-download',
      '--quiet',
      '--no-warnings',
    ],
    { timeoutMs: 30_000, maxBufferMb: 5 },
  );

  const item = records[0];
  if (!item) {
    throw new YtdlpError(`channelInfo: no metadata for ${channelId}`);
  }

  const rawDescription = item['description'];
  const description = typeof rawDescription === 'string' && rawDescription.trim()
    ? rawDescription
    : null;

  const thumbs = (item['thumbnails'] as Array<{ url?: string; height?: number }> | undefined) ?? [];
  let best: { url: string; height: number } | null = null;
  for (const t of thumbs) {
    if (typeof t.url !== 'string') continue;
    const h = typeof t.height === 'number' ? t.height : 0;
    if (!best || h > best.height) best = { url: t.url, height: h };
  }
  const avatarUrl = best?.url ?? null;

  return { description, avatarUrl };
}

// Resolve a channel reference to its id and title (block-channel CLI). A video
// reads its own metadata; a channel page reads the playlist root without
// enumerating any videos. Null when yt-dlp returns no channel id.
export async function channelIdentity(lookup: ChannelLookup): Promise<ChannelIdentity | null> {
  const isVideo = lookup.kind === 'video';
  const url = lookup.kind === 'video' ? `https://www.youtube.com/watch?v=${lookup.videoId}`
    : lookup.kind === 'channel_id' ? `https://www.youtube.com/channel/${lookup.channelId}`
    : lookup.kind === 'handle' ? `https://www.youtube.com/${lookup.handle}`
    : `https://www.youtube.com/user/${encodeURIComponent(lookup.username)}`;
  const records = await runYtdlpLines(
    isVideo
      ? [url, '--dump-json', '--no-playlist', '--no-download', '--quiet', '--no-warnings']
      : [url, '--dump-single-json', '--playlist-items', '0', '--no-download', '--quiet', '--no-warnings'],
    { timeoutMs: 30_000, maxBufferMb: 20 },
  );
  const item = records[0];
  if (!item) return null;
  const channelId = typeof item['channel_id'] === 'string' ? item['channel_id'] : '';
  if (!channelId) return null;
  const name = [item['channel'], item['uploader']].find((v) => typeof v === 'string' && v.trim());
  return { channelId, displayName: typeof name === 'string' ? name : channelId };
}

export async function flatPlaylistChannel(channelId: string): Promise<PlaylistEntry[]> {
  const records = await runYtdlpLines(
    [
      `https://www.youtube.com/channel/${channelId}/videos`,
      '--flat-playlist',
      '--print',
      '%(.{id,title,duration,live_status})j',
      '--no-download',
      '--quiet',
      '--no-warnings',
    ],
    { timeoutMs: 60_000, maxBufferMb: 50 },
  );

  const out: PlaylistEntry[] = [];
  for (const item of records) {
    const videoId = item['id'] as string | undefined;
    if (!videoId) continue;
    out.push({
      videoId,
      title: String(item['title'] ?? ''),
      durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
      liveStatus: typeof item['live_status'] === 'string' ? item['live_status'] : null,
    });
  }
  return out;
}

// Throws on spawn failure AND on unusable output (NaN, ≤0, empty). Callers
// that prefer "treat failure as no-information" wrap with try/catch — that
// policy stays at the call site, not buried in the adapter.
export async function videoDuration(videoId: string): Promise<number> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      config.YTDLP_BIN_M4,
      [
        ...IP_STACK_ARGS,
        `https://www.youtube.com/watch?v=${videoId}`,
        '--print',
        '%(duration)s',
        '--no-download',
        '--quiet',
        '--no-warnings',
      ],
      { maxBuffer: 1024 * 1024, timeout: 15_000 },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new YtdlpError(`videoDuration spawn failed: ${(err as Error).message}`, err);
  }

  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new YtdlpError(`videoDuration: unusable output ${JSON.stringify(stdout)}`);
  }
  return n;
}

// Batched-shaped duration resolver mirroring youtubeapi.videoDurations, so the
// dispatch seam (#193) has one contract for both sources. yt-dlp can't batch —
// it probes per video — so this loops videoDuration, isolating each id: a probe
// that throws (flake, bot-detection, unusable output) drops that id from the
// map rather than poisoning the rest, exactly as the per-video probe behaved
// before. Sequential, not Promise.all, to keep the request rate the throttling
// work (#185) tuned for.
export async function videoDurations(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of ids) {
    try {
      out.set(id, await videoDuration(id));
    } catch {
      // Unusable / flake → no information for this id; omit it. The poller
      // treats a miss as "unknown duration, proceed" (shorts filter can't fire).
    }
  }
  return out;
}
