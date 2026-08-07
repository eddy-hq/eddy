// Manually download a request whose download failed. Returns `{ retry, phase,
// errorMsg }`:
//   - `retry()` POSTs to /requests/:id/retry (failed → downloading + fresh
//     BullMQ job) and kicks the card-rendering queries.
//   - `phase` drives the card UI: 'idle' → tap affordance, 'pending' →
//     optimistic spinner while the POST is in flight, 'polling' → the request
//     is downloading again, 'error' → inline message, tap to re-attempt.
//
// Unlike restore there is no global store: the server flips status to
// 'downloading' synchronously inside the POST and stamps `retried_at`, which
// keeps the row in the /requests/feed payload while it downloads (the feed's
// follow-source exclusion skips retried rows — see migration 040). Refetched
// cards arrive as status='downloading' and Card's native progress UI takes
// over; `phase` only has to cover the tap-to-refetch gap.

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export type RetryPhase = 'idle' | 'pending' | 'polling' | 'error';

export function useRetryDownload(requestId: string): {
  retry: () => Promise<void>;
  phase: RetryPhase;
  errorMsg: string | null;
} {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<RetryPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const retry = useCallback(async () => {
    setPhase('pending');
    setErrorMsg(null);
    let resp: Response;
    try {
      resp = await fetch(`/requests/${requestId}/retry`, { method: 'POST' });
    } catch {
      setPhase('error');
      setErrorMsg("Couldn't reach Eddy. Try again.");
      return;
    }
    if (resp.ok) {
      setPhase('polling');
      // Same query set restore kicks — every view that renders this card.
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
      void queryClient.invalidateQueries({ queryKey: ['search-library'] });
      void queryClient.invalidateQueries({ queryKey: ['person-view'] });
      return;
    }
    // 400 = not retryable from its current status (e.g. another device already
    // retried and it finished), 404 = row gone. Keep it short — the card shows
    // this inline where the timestamp normally sits.
    setPhase('error');
    setErrorMsg(resp.status === 404 ? 'No longer available.' : "Couldn't start. Try again.");
  }, [requestId, queryClient]);

  return { retry, phase, errorMsg };
}
