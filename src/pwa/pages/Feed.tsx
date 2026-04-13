import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { Card, type CardData } from '../components/Card';

interface RequestRow {
  request_id: string;
  title: string | null;
  channel: string | null;
  youtube_id: string | null;
  url: string;
  status: string;
  nginx_url: string | null;
  rejection_reason: string | null;
  requested_at: string;
}

async function fetchRequests(user: string): Promise<RequestRow[]> {
  const param = /^[0-9a-f-]{36}$/.test(user) ? 'userId' : 'user';
  const res = await fetch(`/requests?${param}=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error('Failed to load');
  const data = await res.json() as { requests: RequestRow[] };
  return data.requests;
}

function toCardData(row: RequestRow): CardData {
  return {
    requestId: row.request_id,
    title: row.title ?? row.url,
    channel: row.channel,
    youtubeId: row.youtube_id,
    status: row.status,
    nginxUrl: row.nginx_url,
    requestedAt: row.requested_at,
    rejectionReason: row.rejection_reason,
  };
}

export function Feed() {
  const [params] = useSearchParams();
  const user = params.get('userId') ?? params.get('user') ?? '';
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ['requests', user],
    queryFn: () => fetchRequests(user),
    enabled: !!user,
    refetchInterval: 10_000, // refresh every 10s to catch status changes
  });

  const dismissMutation = useMutation({
    mutationFn: async (requestId: string) => {
      await fetch(`/requests/${requestId}/dismiss`, { method: 'POST' });
    },
    onSuccess: (_data, requestId) => {
      setDismissed((prev) => new Set([...prev, requestId]));
      void queryClient.invalidateQueries({ queryKey: ['requests', userId] });
    },
  });

  if (!user) {
    return <Empty text="No user selected." />;
  }

  if (isLoading) {
    return <Empty text="Loading…" />;
  }

  if (isError) {
    return <Empty text="Could not load requests." />;
  }

  const visible = rows.filter((r) => !dismissed.has(r.request_id));

  if (!visible.length) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)', textAlign: 'center' }}>
        <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-2xl)', marginBottom: 'var(--space-3)' }}>Eddy</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>Nothing here yet. Share a YouTube link to get started.</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>
      {/* Header */}
      <header style={{
        padding: 'var(--space-6) var(--space-4) var(--space-4)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <h1 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 'var(--text-2xl)',
          fontWeight: 300,
          color: 'var(--text-primary)',
        }}>
          Eddy
        </h1>
      </header>

      {/* Cards */}
      <main style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: 'var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}>
        <AnimatePresence mode="popLayout">
          {visible.map((row) => (
            <Card
              key={row.request_id}
              data={toCardData(row)}
              onDismiss={(id) => dismissMutation.mutate(id)}
            />
          ))}
        </AnimatePresence>
      </main>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{text}</p>
    </div>
  );
}
