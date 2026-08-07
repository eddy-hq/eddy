// Manually download a request whose download failed. Returns `{ retry, phase,
// errorMsg }`:
//   - `retry()` POSTs to /requests/:id/retry (failed → downloading + fresh
//     BullMQ job).
//   - `phase` drives the card UI: 'idle' → tap affordance, 'pending' →
//     optimistic spinner while the POST is in flight, 'polling' → the request
//     is downloading again, 'error' → inline message, tap to re-attempt.
//
// Unlike restore there is no global store: the server flips status to
// 'downloading' synchronously inside the POST, so any later fetch of the row
// tells the truth. The deliberate quirk is that we do NOT invalidate the feed
// query on success — follow-sourced rows are excluded from /requests/feed
// while status='downloading' (they normally arrive only when ready), so a
// refetch would unmount the card mid-download. Instead the card stays mounted
// on stale data and Card's useDownloadProgress poll (activated by
// phase === 'polling') carries it through progress → done → playable in place.
// Local state means the affordance resets on navigation — acceptable: the
// server state is already 'downloading', and a remounted card shows the plain
// downloading treatment via the next feed fetch.

import { useCallback, useState } from 'react';

export type RetryPhase = 'idle' | 'pending' | 'polling' | 'error';

export function useRetryDownload(requestId: string): {
  retry: () => Promise<void>;
  phase: RetryPhase;
  errorMsg: string | null;
} {
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
      return;
    }
    // 400 = not retryable from its current status (e.g. another device already
    // retried and it finished), 404 = row gone. Keep it short — the card shows
    // this inline where the timestamp normally sits.
    setPhase('error');
    setErrorMsg(resp.status === 404 ? 'No longer available.' : "Couldn't start. Try again.");
  }, [requestId]);

  return { retry, phase, errorMsg };
}
