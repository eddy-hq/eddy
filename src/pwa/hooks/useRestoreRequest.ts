// Restore a recycled video. Returns `{ restore, entry }` where:
//   - `restore()` POSTs to /requests/:id/restore and flips the global
//     restoring state for this card.
//   - `entry` is the live restore state (or null when idle): includes
//     `errored` so the card can surface an inline error.
//
// The actual transition back to file_state='live' happens when the worker
// completion callback fires `mark_restored` on the M4. The PWA picks that up
// via the existing TanStack feed/search queries — see useRestorePolling for
// the short polling window we run while any restore is in flight.

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRestoreStore, type RestoreEntry } from '../store/restore';

// Safety cap: drop in-flight entries that have been "restoring" longer than
// this. A stuck worker, a Redis outage, or a job that landed in failed state
// would otherwise leave the spinner overlay forever. Two minutes is generous
// for a typical re-download; if the file really isn't back by then, surfacing
// the inert card (a regular recycled card, tap to retry) is the right move.
const STUCK_CAP_MS = 2 * 60_000;

export function useRestoreRequest(requestId: string): {
  restore: () => Promise<void>;
  entry: RestoreEntry | null;
} {
  const queryClient = useQueryClient();
  const entry = useRestoreStore((s) => s.entries[requestId] ?? null);
  const start = useRestoreStore((s) => s.start);
  const finish = useRestoreStore((s) => s.finish);
  const fail = useRestoreStore((s) => s.fail);

  // Drop entries that have been restoring past the safety cap. Without this
  // the spinner overlay would stay on forever if the worker never reports
  // back — see STUCK_CAP_MS rationale above.
  useEffect(() => {
    if (!entry || entry.errored) return;
    const remaining = STUCK_CAP_MS - (Date.now() - entry.startedAt);
    if (remaining <= 0) {
      finish(requestId);
      return;
    }
    const t = setTimeout(() => finish(requestId), remaining);
    return () => clearTimeout(t);
  }, [entry, requestId, finish]);

  const restore = useCallback(async () => {
    // Optimistic flip — kid sees the spinner overlay before the network call
    // returns. The brief calls for "immediate visual feedback (no UI hang)".
    start(requestId);
    let resp: Response;
    try {
      resp = await fetch(`/requests/${requestId}/restore`, { method: 'POST' });
    } catch {
      fail(requestId, "Couldn't reach Eddy. Try again.");
      return;
    }
    if (resp.status === 202) {
      // Kick the queries that render cards so they pick up the worker
      // callback's file_state flip as soon as it lands. The restore store
      // entry sticks around — `useRestorePolling` keeps the queries refetching
      // on a short interval until the row reads as 'live' (or the cap fires).
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
      void queryClient.invalidateQueries({ queryKey: ['search-library'] });
      void queryClient.invalidateQueries({ queryKey: ['person-view'] });
      return;
    }
    // 400 (wrong state — likely already restored / live), 404 (deleted),
    // 500 (enqueue failed). Surface a short message; the store stays in
    // errored mode so the card shows the inline error.
    let message = "Couldn't restore. Try again.";
    if (resp.status === 404) message = 'No longer available.';
    else if (resp.status === 400) message = 'Already back.';
    fail(requestId, message);
  }, [requestId, start, fail, queryClient]);

  return { restore, entry };
}
