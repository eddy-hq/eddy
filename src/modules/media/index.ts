import { config } from '../../config';

// Rewrite a persisted nginx URL (http://<mediaserver>/videos/foo.mp4) to its
// public HTTPS equivalent (https://eddyhq.app/videos/foo.mp4). Required because
// the PWA is served from https://eddyhq.app/ and browsers block mixed-content
// http:// media on an https page. The DB still stores the LAN URL — rewriting
// happens at the API boundary so a future scheme change is one-config-flip.
//
// Returns the input unchanged when no rewrite rule applies (dev mode, unknown
// host, already https, or null).
export function toPublicMediaUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null;

  const videoFrom = config.NGINX_VIDEO_BASE_URL;
  const videoTo = config.PUBLIC_VIDEO_BASE_URL;
  if (videoFrom && videoTo && url.startsWith(videoFrom)) {
    return videoTo + url.slice(videoFrom.length);
  }

  const thumbFrom = config.NGINX_THUMB_BASE_URL;
  const thumbTo = config.PUBLIC_THUMB_BASE_URL;
  if (thumbFrom && thumbTo && url.startsWith(thumbFrom)) {
    return thumbTo + url.slice(thumbFrom.length);
  }

  return url;
}
