// While any restore is in flight, refresh the feed/saved/search queries on a
// short interval so the card's file_state flips back to 'live' automatically
// once the worker callback lands. The brief explicitly says: "do not
// introduce websocket / SSE / long-polling infrastructure for this" — polling
// a tight window while actively needed is the chosen pattern.
//
// Idle (no restores in flight) — does nothing.
// Active — invalidates ['feed'] and ['search-library'] every POLL_MS until
// every in-flight entry clears (by `finish` from useRestoreRequest when a
// card sees its own row come back as 'live', or by the safety cap there).

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRestoreStore } from '../store/restore';

const POLL_MS = 6_000;

export function useRestorePolling(): void {
  const queryClient = useQueryClient();
  // Only re-render this hook (and reset the interval) when the *count* of
  // restoring entries changes — not when an inner field flips. We don't need
  // per-entry granularity, just "is anything in flight?".
  const activeCount = useRestoreStore((s) => {
    let n = 0;
    for (const id in s.entries) {
      const e = s.entries[id];
      if (e && !e.errored) n++;
    }
    return n;
  });

  useEffect(() => {
    if (activeCount === 0) return;
    const t = setInterval(() => {
      // Invalidate the known card-bearing query roots. Each key is a prefix;
      // TanStack matches all queries whose key starts with it, so per-user
      // and per-search variants all get refreshed. Invalidating a key with
      // no active subscribers is a no-op — no harm in listing keys for
      // surfaces that aren't currently mounted.
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
      void queryClient.invalidateQueries({ queryKey: ['search-library'] });
      void queryClient.invalidateQueries({ queryKey: ['person-view'] });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [activeCount, queryClient]);
}
