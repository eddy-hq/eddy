import React from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import type { WatchSource } from '../lib/watchEvents';

const ALLOWED_SOURCES: ReadonlySet<WatchSource> = new Set([
  'feed', 'discovery', 'search', 'channel', 'history', 'saved', 'notification', 'direct',
]);

function parseSource(raw: string | null): WatchSource {
  if (raw && (ALLOWED_SOURCES as Set<string>).has(raw)) return raw as WatchSource;
  return 'direct';
}

// Thin route shim: mounts the sheet in id-mode for /watch/:requestId. Notification
// deep links and search results land here. The sheet handles fetching, polling
// while non-ready, and the player UI; this component only owns close navigation.
export function Watch() {
  const { requestId } = useParams<{ requestId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const source = parseSource(params.get('from'));
  const queryClient = useQueryClient();

  function onClose() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    // Read userId out of the sheet's cache entry — single source of truth for
    // ['request', :id]. If the sheet's query hasn't resolved yet (rare: user
    // dismisses before the round-trip), fall back to /feed.
    const cached = queryClient.getQueryData<{ userId?: string | null }>(['request', requestId]);
    const userId = cached?.userId;
    navigate(userId ? `/feed?userId=${encodeURIComponent(userId)}` : '/feed', { replace: true });
  }

  if (!requestId) {
    return null;
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>
      <AnimatePresence>
        <VideoDetailSheet
          key={requestId}
          requestId={requestId}
          source={source}
          onClose={onClose}
        />
      </AnimatePresence>
    </div>
  );
}
