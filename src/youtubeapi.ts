// Adapter for YouTube Data API v3 metadata calls. The structural twin of
// src/ytdlp.ts: it returns the SAME exported shapes (SearchVideoWithDate,
// PlaylistEntry, ChannelInfo) so the dispatch seam (src/discovery-metadata.ts)
// can swap sources with nothing downstream changing. yt-dlp stays the download
// path and the DISCOVERY_SOURCE=ytdlp fallback; this module never downloads.
//
// Reads public data only — a plain API key, no OAuth (#189). All functions
// throw YoutubeApiError on failure; callers that want "treat failure as empty"
// wrap with try/catch, exactly as with the yt-dlp adapter.
import { config } from './config';
import type { SearchVideoWithDate, PlaylistEntry, ChannelInfo } from './ytdlp';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// search.list won't return videos older than this. Mirrors discovery's
// FRESHNESS_WINDOW_DAYS (modules/discovery/intake.ts) — search.list costs 100
// units regardless of filters, so pushing the date bound server-side doesn't
// save quota, it just stops stale results from crowding out usable ones in the
// fixed 50-result page. Kept as a local constant rather than importing the
// discovery internal to avoid coupling the adapter to that module.
const SEARCH_FRESHNESS_DAYS = 180;

export class YoutubeApiError extends Error {
  // Set when YouTube returns a quota error (HTTP 403 with a quotaExceeded /
  // dailyLimitExceeded reason). Callers use it to stand discovery down for the
  // rest of the day (#194), mirroring how YtdlpError.botDetection arms the
  // IP-wide cooldown.
  public readonly quotaExceeded: boolean;
  constructor(message: string, opts?: { quotaExceeded?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'YoutubeApiError';
    this.quotaExceeded = opts?.quotaExceeded ?? false;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

// Normalised per-video metadata, the common shape behind the public adapter
// functions. Exported so the back-catalogue (#191) and duration (#193) slices
// can reuse fetchVideoMetadata directly.
export interface VideoMetadata {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  durationSecs: number | null;
  viewCount: number | null;
  uploadDate: string | null; // YYYYMMDD, matching yt-dlp's upload_date contract
  thumbnailUrl: string | null;
  liveStatus: string | null;
}

interface SearchListResponse {
  items?: Array<{ id?: { videoId?: string } }>;
}

interface VideoItem {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}

interface VideosListResponse {
  items?: VideoItem[];
}

// Single GET against the Data API. Appends the key, surfaces quota errors as a
// flagged YoutubeApiError, and never logs the key (it stays in the URL object,
// not in thrown messages).
async function apiGet<T>(resource: string, params: Record<string, string>): Promise<T> {
  const key = config.YOUTUBE_API_KEY;
  if (!key) throw new YoutubeApiError('YOUTUBE_API_KEY is not set');

  const url = new URL(`${API_BASE}/${resource}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', key);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new YoutubeApiError(`YouTube API ${resource} unreachable: ${String(err)}`, { cause: err });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const quotaExceeded = response.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(body);
    throw new YoutubeApiError(
      `YouTube API ${resource} returned ${response.status}`,
      { quotaExceeded },
    );
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new YoutubeApiError(`YouTube API ${resource} returned invalid JSON`, { cause: err });
  }
}

// Parse an ISO-8601 duration (contentDetails.duration, e.g. "PT1H2M3S",
// "PT45S", "P0D" for live/premieres) into whole seconds. Returns null when
// unparseable or non-positive — matching the null-duration contract the
// SearchVideoWithDate / PlaylistEntry shapes already use, and the
// reject-≤0 stance of yt-dlp's videoDuration.
export function parseIso8601Duration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  const total = ((days * 24 + hours) * 60 + mins) * 60 + secs;
  return total > 0 ? total : null;
}

// Take the date portion of an ISO-8601 timestamp (snippet.publishedAt, UTC)
// and return it as YYYYMMDD — the format yt-dlp emits for upload_date and that
// uploadDateToIso (modules/discovery/util) expects. String-sliced rather than
// Date-parsed so a near-midnight UTC timestamp can't shift a day.
function publishedAtToYmd(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

// snippet.thumbnails is an object keyed by size. Pick the largest available.
function pickThumbnail(thumbs: Record<string, { url?: string }> | undefined): string | null {
  if (!thumbs) return null;
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbs[size]?.url;
    if (url) return url;
  }
  return null;
}

// Map the API's liveBroadcastContent ('none' | 'live' | 'upcoming') onto the
// yt-dlp live_status values the discovery filters check (is_live /
// is_upcoming). Anything else (a normal VOD) is null.
function mapLiveStatus(v: unknown): string | null {
  if (v === 'live') return 'is_live';
  if (v === 'upcoming') return 'is_upcoming';
  return null;
}

function toViewCount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Batched videos.list — up to 50 ids per call, 1 quota unit each. Returns a map
// keyed by video id; ids the API omits (private / removed / age-gated) are
// simply absent. Reused by the back-catalogue and duration slices.
export async function fetchVideoMetadata(ids: string[]): Promise<Map<string, VideoMetadata>> {
  const out = new Map<string, VideoMetadata>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    if (batch.length === 0) continue;
    const data = await apiGet<VideosListResponse>('videos', {
      part: 'snippet,contentDetails,statistics',
      id: batch.join(','),
      maxResults: '50',
    });
    for (const item of data.items ?? []) {
      const id = item.id;
      if (typeof id !== 'string') continue;
      const sn = item.snippet ?? {};
      const cd = item.contentDetails ?? {};
      const st = item.statistics ?? {};
      out.set(id, {
        videoId: id,
        title: String(sn.title ?? ''),
        channel: String(sn.channelTitle ?? ''),
        channelId: String(sn.channelId ?? ''),
        durationSecs: typeof cd.duration === 'string' ? parseIso8601Duration(cd.duration) : null,
        viewCount: toViewCount(st.viewCount),
        uploadDate: publishedAtToYmd(sn.publishedAt),
        thumbnailUrl: pickThumbnail(sn.thumbnails),
        liveStatus: mapLiveStatus(sn.liveBroadcastContent),
      });
    }
  }
  return out;
}

// Interest search. search.list (100 units) returns relevance-ordered video ids
// within the freshness window; a single batched videos.list (1 unit) fills the
// durations, view counts and real upload dates search.list doesn't carry.
// Preserves search.list's relevance order. Projects to SearchVideoWithDate so
// it is a drop-in for yt-dlp's searchVideosWithDates.
export async function searchVideosWithDates(
  query: string,
  limit = 10,
): Promise<SearchVideoWithDate[]> {
  const publishedAfter = new Date(
    Date.now() - SEARCH_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const search = await apiGet<SearchListResponse>('search', {
    part: 'snippet',
    q: query,
    type: 'video',
    order: 'relevance',
    maxResults: String(Math.min(Math.max(Math.trunc(limit), 1), 50)),
    publishedAfter,
  });

  const ids: string[] = [];
  for (const item of search.items ?? []) {
    const id = item.id?.videoId;
    if (typeof id === 'string') ids.push(id);
  }
  if (ids.length === 0) return [];

  const meta = await fetchVideoMetadata(ids);

  const out: SearchVideoWithDate[] = [];
  for (const id of ids) {
    const m = meta.get(id);
    if (!m) continue;
    out.push({
      videoId: m.videoId,
      title: m.title,
      channel: m.channel,
      durationSecs: m.durationSecs,
      viewCount: m.viewCount,
      uploadDate: m.uploadDate,
      thumbnailUrl: m.thumbnailUrl,
      liveStatus: m.liveStatus,
      url: `https://www.youtube.com/watch?v=${m.videoId}`,
    });
  }
  return out;
}

// Placeholders for the remaining slices, so the dispatch seam can route all
// four functions through one source. Filled in by #191 (back-catalogue via
// playlistItems.list), #192 (channel info via channels.list), #193 (duration
// via batched videos.list). Until then the seam delegates these to yt-dlp.
export async function flatPlaylistChannel(_channelId: string): Promise<PlaylistEntry[]> {
  throw new YoutubeApiError('flatPlaylistChannel via Data API not yet implemented (#191)');
}

export async function channelInfo(_channelId: string): Promise<ChannelInfo> {
  throw new YoutubeApiError('channelInfo via Data API not yet implemented (#192)');
}

export async function videoDuration(_videoId: string): Promise<number> {
  throw new YoutubeApiError('videoDuration via Data API not yet implemented (#193)');
}
