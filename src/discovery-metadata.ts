// Dispatch seam for discovery's metadata reads (#189). Selects the YouTube
// Data API (DISCOVERY_SOURCE=api) or yt-dlp scraping (default) per call, with
// identical return contracts either way — the four shapes are defined in
// ytdlp.ts and youtubeapi.ts returns the same ones. The discovery call sites
// import the four functions from here, not from ytdlp/youtubeapi directly.
//
// Downloads are NOT routed through here: the worker's authenticated download
// path stays on yt-dlp by design (ADR — Eddy owns the video files).
//
// All four metadata reads now dispatch on DISCOVERY_SOURCE: searchVideosWithDates
// (#190), flatPlaylistChannel (#191), channelInfo (#192), videoDuration (#193).
import { config } from './config';
import * as ytdlp from './ytdlp';
import * as api from './youtubeapi';

export type { SearchVideoWithDate, PlaylistEntry, ChannelInfo } from './ytdlp';

const useApi = (): boolean => config.DISCOVERY_SOURCE === 'api';

export function searchVideosWithDates(query: string, limit?: number) {
  return useApi()
    ? api.searchVideosWithDates(query, limit)
    : ytdlp.searchVideosWithDates(query, limit);
}

export function flatPlaylistChannel(channelId: string) {
  return useApi()
    ? api.flatPlaylistChannel(channelId)
    : ytdlp.flatPlaylistChannel(channelId);
}

export function channelInfo(channelId: string) {
  return useApi() ? api.channelInfo(channelId) : ytdlp.channelInfo(channelId);
}

export function videoDuration(videoId: string) {
  return useApi() ? api.videoDuration(videoId) : ytdlp.videoDuration(videoId);
}
