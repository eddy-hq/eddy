import { RefObject, useEffect, useRef } from 'react';

export type WatchSource =
  | 'feed' | 'discovery' | 'search' | 'channel'
  | 'history' | 'saved' | 'notification' | 'direct' | 'person';

export type WatchReason = 'ended' | 'dismissed' | 'navigated' | 'backgrounded';

export interface WatchEventInput {
  userId: string;
  requestId: string;
  videoId: string;
  source: WatchSource;
  startedAt: string;
  endedAt: string;
  positionS: number;
  durationS: number;
  reason: WatchReason;
}

const ENDPOINT = '/watch-events';
const DISMISS_POSITION_S = 5;
const DISMISS_FRACTION = 0.05;

function send(event: WatchEventInput): void {
  const payload = JSON.stringify({ events: [event] });
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([payload], { type: 'application/json' });
    if (navigator.sendBeacon(ENDPOINT, blob)) return;
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => { /* best-effort */ });
}

export function useWatchEventTracker(opts: {
  videoRef: RefObject<HTMLVideoElement | null>;
  userId: string;
  requestId: string;
  videoId: string | null;
  source: WatchSource;
}) {
  const { videoRef, userId, requestId, videoId, source } = opts;

  const recordedRef = useRef(false);
  const startedAtIsoRef = useRef<string | null>(null);
  const lastDurationRef = useRef(0);
  const lastPositionRef = useRef(0);

  // Record fn is held in a ref so cleanup/listeners always read the latest props.
  const recordRef = useRef<(reason: WatchReason) => void>(() => { /* assigned below */ });
  recordRef.current = (reason: WatchReason): void => {
    if (recordedRef.current) return;
    if (!videoId || !startedAtIsoRef.current) return;
    if (lastDurationRef.current <= 0) return;
    recordedRef.current = true;
    send({
      userId, requestId, videoId, source,
      startedAt: startedAtIsoRef.current,
      endedAt: new Date().toISOString(),
      positionS: Math.round(lastPositionRef.current),
      durationS: Math.round(lastDurationRef.current),
      reason,
    });
  };

  function ensureStart() {
    if (startedAtIsoRef.current === null) {
      startedAtIsoRef.current = new Date().toISOString();
    }
  }

  function syncFromVideo() {
    const v = videoRef.current;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0) lastDurationRef.current = v.duration;
    if (Number.isFinite(v.currentTime)) lastPositionRef.current = v.currentTime;
  }

  // Page-level events: backgrounding or unload should still get a row.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        syncFromVideo();
        recordRef.current('backgrounded');
      }
    }
    function onPageHide() {
      syncFromVideo();
      recordRef.current('backgrounded');
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  // Unmount: sheet closed or route changed. Pick reason from how far we got.
  useEffect(() => {
    return () => {
      syncFromVideo();
      const pos = lastPositionRef.current;
      const dur = lastDurationRef.current;
      const dismissed = dur <= 0 || pos < DISMISS_POSITION_S || pos / dur < DISMISS_FRACTION;
      recordRef.current(dismissed ? 'dismissed' : 'navigated');
    };
  }, []);

  return {
    onPlay: () => { ensureStart(); },
    onTimeUpdate: () => { ensureStart(); syncFromVideo(); },
    onEnded: () => {
      const v = videoRef.current;
      if (v && Number.isFinite(v.duration) && v.duration > 0) {
        lastDurationRef.current = v.duration;
        lastPositionRef.current = v.duration;
      }
      recordRef.current('ended');
    },
  };
}
