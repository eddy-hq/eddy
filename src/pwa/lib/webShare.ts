// Web Share API helpers, extracted so the Share tile in VideoDetailSheet has
// a single, pure place to ask "can I share?" and "share this video" — and so
// vitest (node env) can cover both branches without dragging in jsdom.

export interface ShareVideoInput {
  url: string;
  title?: string | null;
}

export interface ShareVideoDeps {
  // Injected so tests don't need to monkey-patch `navigator`. In the PWA the
  // call site binds these to `navigator.share` / `'share' in navigator`.
  share?: ((data: ShareData) => Promise<void>) | null;
}

// True when the runtime exposes `navigator.share`. The Share tile is hidden
// entirely when this is false — issue #137 explicitly rules out rendering a
// dead control.
export function canShare(deps: ShareVideoDeps): boolean {
  return typeof deps.share === 'function';
}

// Fire the Web Share sheet with the canonical YouTube watch URL. Title is
// passed when present so OS share sheets that surface it (iOS in particular)
// get a useful preview line. AbortError fires when the user dismisses the
// sheet — treat it as a no-op rather than an error.
export async function shareVideo(
  input: ShareVideoInput,
  deps: ShareVideoDeps,
): Promise<void> {
  if (!deps.share) return;
  const data: ShareData = input.title
    ? { url: input.url, title: input.title }
    : { url: input.url };
  try {
    await deps.share(data);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    throw err;
  }
}
