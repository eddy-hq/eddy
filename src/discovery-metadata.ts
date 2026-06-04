// Dispatch seam for discovery's metadata reads (#189). Selects the YouTube
// Data API (DISCOVERY_SOURCE=api) or yt-dlp scraping (default) per call, with
// identical return contracts either way — the four shapes are defined in
// ytdlp.ts and youtubeapi.ts returns the same ones. The discovery call sites
// import the four functions from here, not from ytdlp/youtubeapi directly.
//
// Downloads are NOT routed through here: the worker's authenticated download
// path stays on yt-dlp by design (ADR — Eddy owns the video files).
//
// Staged rollout: only searchVideosWithDates is wired to the API in #190. The
// other three delegate to yt-dlp until their slices land (#191 back-catalogue,
// #192 channel info, #193 duration), at which point each gains the same
// useApi() branch.
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

// #191 — flip to `useApi() ? api.flatPlaylistChannel(...) : ...`
export function flatPlaylistChannel(channelId: string) {
  return ytdlp.flatPlaylistChannel(channelId);
}

// #192
export function channelInfo(channelId: string) {
  return ytdlp.channelInfo(channelId);
}

// #193
export function videoDuration(videoId: string) {
  return ytdlp.videoDuration(videoId);
}
