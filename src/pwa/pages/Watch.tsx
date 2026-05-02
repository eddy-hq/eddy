import React from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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

interface RequestDetail {
  userId: string | null;
}

async function fetchRequest(id: string): Promise<RequestDetail> {
  const res = await fetch(`/requests/${id}`);
  if (!res.ok) throw new Error('Not found');
  return res.json() as Promise<RequestDetail>;
}

// Thin route shim: mounts the sheet in id-mode for /watch/:requestId. Notification
// deep links and search results land here. The sheet handles fetching, polling
// while non-ready, and the player UI; this component only owns close navigation.
export function Watch() {
  const { requestId } = useParams<{ requestId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const source = parseSource(params.get('from'));

  // Reuses the sheet's query cache — React Query dedups on the shared key, so
  // this doesn't double-fetch; we just need userId for the home fallback.
  const { data } = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => fetchRequest(requestId!),
    enabled: !!requestId,
  });

  function onClose() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    const userId = data?.userId;
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
