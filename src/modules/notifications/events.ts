// NotificationEvent — the discriminated union describing every notification the
// system can emit. The `notify(event, recipient)` adapter maps each `kind` to a
// transport payload internally, so adding a new event type is a single case
// here plus a single branch in `notify.ts` — no new public export and no new
// module surface area.
//
// There is exactly one transport at a time (ADR-0003) — log-only today, APNs
// when the native iOS shell ships. This union is event-type fan-in, not
// transport pluggability.

export type NotificationEvent =
  | VideoReadyEvent
  | DownloadAlertEvent
  | ParentReviewEvent
  | CircuitOpenEvent
  | DownloadFailureStreakEvent
  | DecisionsWaitingEvent;

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
// (ADR-0012). Not addressed to a kid — the adult recipient only.
export interface CircuitOpenEvent {
  kind: 'circuit_open';
  consecutiveTrips: number;
}

// Sent to Steve when consecutive terminal download failures cross the
// threshold — the signature-blind safety net behind the bot-detection
// regex (2026-07-31 flagged-jar incident: a week of mid-transfer 403s
// tripped nothing). One alert per streak; a successful download re-arms.
export interface DownloadFailureStreakEvent {
  kind: 'download_failure_streak';
  consecutiveFailures: number;
  // First line of the last failure's error — the signature, not a stack.
  lastError: string;
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

// Sent to each parent once a day when the Decisions queue for Today is
// non-empty (Phase 6a daily nudge). A count only — no titles, channels or kid
// names — and the tap opens /decisions.
export interface DecisionsWaitingEvent {
  kind: 'decisions_waiting';
  count: number;
}
