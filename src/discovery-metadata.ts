// Dispatch seam for YouTube metadata reads (#189). Selects the YouTube Data API
// (DISCOVERY_SOURCE=api) or yt-dlp scraping (default) per call, with identical
// return contracts either way — the shapes are defined in ytdlp.ts and
// youtubeapi.ts returns the same ones. Call sites import from here, not from
// ytdlp/youtubeapi directly, so this is the single point where the last
// non-download yt-dlp consumers route to the API.
//
// Downloads are NOT routed through here: the worker's authenticated download
// path stays on yt-dlp by design (ADR — Eddy owns the video files).
//
// Discovery reads dispatched here: searchVideosWithDates (#190),
// flatPlaylistChannel (#191), channelInfo (#192), videoDurations (#193,
// batched), recentUploads (the daily follow poll), videoMetadata (guard inputs
// for discovery candidates, Phase 6a). Interactive parent-facing UI
// searches also dispatch here: searchVideosFlat (search-videos route) and
// searchChannelsFlat (people-search route) — the same source switch, but with
// no freshness bound.
import { config } from './config';
import * as ytdlp from './ytdlp';
import * as api from './youtubeapi';

export type {
  SearchVideoWithDate,
  SearchVideoFlat,
  SearchChannel,
  PlaylistEntry,
  ChannelInfo,
} from './ytdlp';

const useApi = (): boolean => config.DISCOVERY_SOURCE === 'api';

export function searchVideosWithDates(query: string, limit?: number) {
  return useApi()
    ? api.searchVideosWithDates(query, limit)
    : ytdlp.searchVideosWithDates(query, limit);
}

// Interactive parent-facing video search — no freshness bound, unlike the
// discovery read above (see youtubeapi.searchVideosFlat).
export function searchVideosFlat(query: string, limit?: number) {
  return useApi()
    ? api.searchVideosFlat(query, limit)
    : ytdlp.searchVideosFlat(query, limit);
}

// Kid video search: the Data API with safeSearch=strict. Like recentUploads
// there is deliberately no yt-dlp equivalent — ytsearch has no safe-search
// control, so raw YouTube results would reach a kid unfiltered. The fallback
// source returns null and the route reports search as unavailable.
export function searchVideosFlatStrict(
  query: string,
  limit?: number,
): Promise<ytdlp.SearchVideoFlat[] | null> {
  return useApi()
    ? api.searchVideosFlat(query, limit, { safeSearch: 'strict' })
    : Promise.resolve(null);
}

export function searchChannelsFlat(query: string, limit?: number) {
  return useApi()
    ? api.searchChannelsFlat(query, limit)
    : ytdlp.searchChannelsFlat(query, limit);
}

export function flatPlaylistChannel(channelId: string) {
  return useApi()
    ? api.flatPlaylistChannel(channelId)
    : ytdlp.flatPlaylistChannel(channelId);
}

export function channelInfo(channelId: string) {
  return useApi() ? api.channelInfo(channelId) : ytdlp.channelInfo(channelId);
}

export type { RecentUpload } from './youtubeapi';

// The follow poll's listing of a channel's newest uploads. Under the API source
// this is one playlistItems.list call (1 unit). There is no yt-dlp equivalent
// on purpose — a per-channel scrape every day is exactly the exposure ADR-0012
// budgets away — so the fallback source returns null and the poller keeps its
// RSS read.
export function recentUploads(channelId: string): Promise<api.RecentUpload[] | null> {
  return useApi() ? api.recentUploads(channelId) : Promise.resolve(null);
}

// Batched (#193): resolve many ids in one Data API call, or loop the per-video
// yt-dlp probe under the fallback. Returns a map of id → positive seconds; a
// missing id means "no usable duration", which the caller treats as unknown.
export function videoDurations(ids: string[]) {
  return useApi() ? api.videoDurations(ids) : ytdlp.videoDurations(ids);
}

export type { VideoMetadata } from './youtubeapi';

// Guard inputs for discovery candidates (Phase 6a): description, tags,
// category, age restriction and the made-for-kids setting, batched 50 ids per
// call at 1 unit each. Like recentUploads there is no yt-dlp equivalent on
// purpose — a per-candidate scrape is extra IP exposure (ADR-0011/0012) — so
// the fallback source returns null and the guard runs on its existing inputs.
export function videoMetadata(ids: string[]): Promise<Map<string, api.VideoMetadata> | null> {
  return useApi() ? api.fetchVideoMetadata(ids) : Promise.resolve(null);
}
