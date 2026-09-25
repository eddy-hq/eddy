// Pure helpers for Blocked channels: the kid-facing reason, and parsing what a
// parent types at the CLI into a channel reference to resolve.

// Kid-facing reason on a request rejected because its channel is blocked. The
// request lands as an ordinary rejection, so the Appeal ("Ask a grown-up")
// copy shows under it as for any other rejection.
export const BLOCKED_CHANNEL_REASON = 'A grown-up has blocked this channel';

// What a parent can hand the block-channel CLI.
//   channel_id  UC... id, bare or in a /channel/ URL
//   handle      @handle, bare or in a youtube.com/@handle URL
//   username    legacy /user/<name> URL
//   video       a watch / youtu.be / shorts URL, or a bare 11-char video id
export type ChannelRef =
  | { kind: 'channel_id'; channelId: string }
  | { kind: 'handle'; handle: string }
  | { kind: 'username'; username: string }
  | { kind: 'video'; videoId: string };

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HANDLE_RE = /^@[A-Za-z0-9._-]{1,100}$/;

export function isChannelId(value: string): boolean {
  return CHANNEL_ID_RE.test(value);
}

// Null when the input isn't a form we can resolve (including legacy /c/
// vanity URLs, which neither the Data API nor a stable URL maps to an id).
export function parseChannelRef(input: string): ChannelRef | null {
  const raw = input.trim();
  if (!raw) return null;
  if (CHANNEL_ID_RE.test(raw)) return { kind: 'channel_id', channelId: raw };
  if (HANDLE_RE.test(raw)) return { kind: 'handle', handle: raw };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

  if (host === 'youtu.be') {
    const id = parts[0];
    return id && VIDEO_ID_RE.test(id) ? { kind: 'video', videoId: id } : null;
  }
  if (host !== 'youtube.com') {
    // A bare video id only reaches here as "https://<id>" — no dot in it.
    return VIDEO_ID_RE.test(raw) ? { kind: 'video', videoId: raw } : null;
  }

  const [first, second] = parts;
  if (first === 'watch') {
    const v = url.searchParams.get('v');
    return v && VIDEO_ID_RE.test(v) ? { kind: 'video', videoId: v } : null;
  }
  if ((first === 'shorts' || first === 'live' || first === 'embed') && second && VIDEO_ID_RE.test(second)) {
    return { kind: 'video', videoId: second };
  }
  if (first === 'channel' && second && CHANNEL_ID_RE.test(second)) {
    return { kind: 'channel_id', channelId: second };
  }
  if (first === 'user' && second) return { kind: 'username', username: second };
  if (first && HANDLE_RE.test(first)) return { kind: 'handle', handle: first };
  return null;
}
