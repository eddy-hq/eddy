// Pure decision for what tapping a video card does. Extracted from
// Card.handleTap so the state matrix is unit-testable (Vitest runs in node —
// no RTL/jsdom, see the AFK-testing note in AGENTS.md).
//
// Ordering matters and mirrors the card's visual affordances:
//   1. recycled       → restore (existing flow, issue #116)
//   2. live-or-done   → play. Checked before `failed` because a card whose
//      manual retry just completed still carries stale status='failed' until
//      the next feed refetch — `downloadDone` (the client poll result) is the
//      earlier truth and the tap should play, not re-retry.
//   3. failed         → retry the download (manual download-on-tap)
//   4. otherwise      → inert (downloading / guard_review / rejected / gone…)
//
// `retryInFlight` suppresses a second tap while a manual retry is pending or
// polling — the card is showing spinner/progress and another POST would just
// cancel and re-enqueue the same job. `downloadDone` is the client-side poll
// result that flips a card live before the next feed refetch.

export type CardTapAction = 'play' | 'restore' | 'retry' | null;

export interface CardTapState {
  status: string;
  fileState: string;
  nginxUrl: string | null;
  downloadDone: boolean;
  isRestoring: boolean;
  retryInFlight: boolean;
}

export function cardTapAction(s: CardTapState): CardTapAction {
  const isLive =
    ['ready', 'watched'].includes(s.status) && s.fileState === 'live' && !!s.nginxUrl;
  const isRecycled =
    ['ready', 'watched'].includes(s.status) && s.fileState === 'recycled';

  if (isRecycled) return s.isRestoring ? null : 'restore';
  if (isLive || s.downloadDone) return 'play';
  // A failed row keeps file_state 'live' (no file was ever produced), so the
  // status check alone identifies it. 'gone' can't co-occur with 'failed'.
  if (s.status === 'failed') return s.retryInFlight ? null : 'retry';
  return null;
}
