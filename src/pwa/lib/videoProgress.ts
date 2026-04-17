interface VideoProgress { position: number; duration: number; }

const storageKey = (userId: string, requestId: string) =>
  `eddy:progress:${userId}:${requestId}`;

const LOCAL_EVENT = 'eddy:progress';

interface ProgressEventDetail {
  userId: string;
  requestId: string;
  progress: VideoProgress | null;
}

function dispatch(userId: string, requestId: string, progress: VideoProgress | null) {
  window.dispatchEvent(
    new CustomEvent<ProgressEventDetail>(LOCAL_EVENT, { detail: { userId, requestId, progress } }),
  );
}

export function readProgress(userId: string, requestId: string): VideoProgress | null {
  try {
    const raw = localStorage.getItem(storageKey(userId, requestId));
    return raw ? (JSON.parse(raw) as VideoProgress) : null;
  } catch { return null; }
}

export function writeProgress(
  userId: string, requestId: string, position: number, duration: number,
): void {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
  const value: VideoProgress = { position, duration };
  try {
    localStorage.setItem(storageKey(userId, requestId), JSON.stringify(value));
  } catch { /* storage quota */ }
  dispatch(userId, requestId, value);
}

export function clearProgress(userId: string, requestId: string): void {
  try { localStorage.removeItem(storageKey(userId, requestId)); } catch { /* */ }
  dispatch(userId, requestId, null);
}

// Returns an unsubscribe fn. Fires on same-tab writes and cross-tab storage events.
export function onProgressChange(
  userId: string,
  requestId: string,
  cb: (p: VideoProgress | null) => void,
): () => void {
  const target = storageKey(userId, requestId);

  function onStorage(e: StorageEvent) {
    if (e.key !== target) return;
    try { cb(e.newValue ? (JSON.parse(e.newValue) as VideoProgress) : null); }
    catch { /* malformed */ }
  }

  function onLocal(e: Event) {
    const { detail } = e as CustomEvent<ProgressEventDetail>;
    if (detail.userId !== userId || detail.requestId !== requestId) return;
    cb(detail.progress);
  }

  window.addEventListener('storage', onStorage);
  window.addEventListener(LOCAL_EVENT, onLocal);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(LOCAL_EVENT, onLocal);
  };
}
