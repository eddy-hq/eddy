// NotificationEvent — the discriminated union describing every notification the
// system can emit. The `notify(event, recipient)` adapter maps each `kind` to
// an ntfy topic + payload internally, so adding a new event type is a single
// case here plus a single branch in `notify.ts` — no new public export and no
// new module surface area.
//
// ntfy stays the only transport (per `CLAUDE.md`); this union is event-type
// fan-in, not transport pluggability.

export type NotificationEvent =
  | VideoReadyEvent
  | DownloadAlertEvent
  | ParentReviewEvent
  | CircuitOpenEvent;

// Sent to a kid when their video is downloaded and ready to watch.
export interface VideoReadyEvent {
  kind: 'video_ready';
  requestId: string;
  title: string;
}

// Sent to Steve when the watchdog detects a stuck or re-enqueued download.
export interface DownloadAlertEvent {
  kind: 'download_alert';
  requestId: string;
  title: string;
  stuckMins: number;
  action: 'alert' | 're-enqueued' | 'failed';
}

// Sent to Steve when the yt-dlp circuit breaker trips: both queues have been
// auto-paused after consecutive bot-detection blocks and resume is manual
// (ADR-0012). Not addressed to a kid — the adult (Steve) topic only.
export interface CircuitOpenEvent {
  kind: 'circuit_open';
  consecutiveTrips: number;
}

// Sent to a parent when a kid's request needs a decision.
export interface ParentReviewEvent {
  kind: 'parent_review';
  requestId: string;
  requesterName: string;
  title: string;
  channel: string;
  reason: string;
  approveToken: string;
  denyToken: string;
}
