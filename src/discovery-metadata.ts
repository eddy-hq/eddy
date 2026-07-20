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
// batched). Interactive parent-facing UI searches also dispatch here:
// searchVideosFlat (search-videos route) and searchChannelsFlat (people-search
// route) — the same source switch, but with no freshness bound.
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

// Batched (#193): resolve many ids in one Data API call, or loop the per-video
// yt-dlp probe under the fallback. Returns a map of id → positive seconds; a
// missing id means "no usable duration", which the caller treats as unknown.
export function videoDurations(ids: string[]) {
  return useApi() ? api.videoDurations(ids) : ytdlp.videoDurations(ids);
}
