import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { Card, type CardData } from '../components/Card';
import { Logo } from '../components/Logo';

// ── Types ────────────────────────────────────────────────────────────────────

interface FeedCard {
  request_id: string;
  title: string | null;
  channel: string | null;
  youtube_id: string | null;
  url: string;
  status: string;
  file_state: string;
  nginx_url: string | null;
  rejection_reason: string | null;
  requested_at: string;
  added_at: string;
  watched_at: string | null;
  saved_at: string | null;
  source: string;
}

interface Section {
  id: string;
  label: string;
  cards: FeedCard[];
}

interface Day {
  date: string;
  label: string;
  cards: FeedCard[];
  sections?: Section[];
}

interface FeedResponse {
  days: Day[];
}

// ── API ──────────────────────────────────────────────────────────────────────

async function fetchFeed(user: string): Promise<FeedResponse> {
  const param = /^[0-9a-f-]{36}$/.test(user) ? 'userId' : 'user';
  const res = await fetch(`/requests/feed?${param}=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error('Failed to load');
  return res.json() as Promise<FeedResponse>;
}

// ── Card adapter ─────────────────────────────────────────────────────────────

function toCardData(row: FeedCard): CardData {
  return {
    requestId: row.request_id,
    title: row.title ?? row.url,
    channel: row.channel,
    youtubeId: row.youtube_id,
    status: row.status,
    fileState: row.file_state,
    nginxUrl: row.nginx_url,
    requestedAt: row.requested_at,
    rejectionReason: row.rejection_reason,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function Feed() {
  const [params] = useSearchParams();
  const user = params.get('userId') ?? params.get('user') ?? '';
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data, isLoading, isError } = useQuery({
    queryKey: ['feed', user],
    queryFn: () => fetchFeed(user),
    enabled: !!user,
    refetchInterval: 10_000,
  });

  const dismissMutation = useMutation({
    mutationFn: async (requestId: string) => {
      await fetch(`/requests/${requestId}/dismiss`, { method: 'POST' });
    },
    onSuccess: (_data, requestId) => {
      setDismissed((prev) => new Set([...prev, requestId]));
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ requestId, saved }: { requestId: string; saved: boolean }) => {
      await fetch(`/requests/${requestId}/save`, { method: saved ? 'DELETE' : 'POST' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feed', user] });
    },
  });

  if (!user) return <Empty text="No user selected." />;
  if (isLoading) return <Empty text="Loading…" />;
  if (isError) return <Empty text="Could not load." />;

  const days = (data?.days ?? []).map((day) => ({
    ...day,
    cards: day.cards.filter((c) => !dismissed.has(c.request_id)),
    sections: day.sections?.map((s) => ({
      ...s,
      cards: s.cards.filter((c) => !dismissed.has(c.request_id)),
    })),
  })).filter((day) => day.cards.length > 0);

  const hasContent = days.length > 0;

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>
      <header style={{
        padding: 'var(--space-6) var(--space-4) var(--space-3)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10,
      }}>
        <Logo />
      </header>

      <main style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--space-4)' }}>
        {!hasContent ? (
          <div style={{ paddingTop: 'var(--space-16)', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
              Nothing here yet. Share a YouTube link to get started.
            </p>
          </div>
        ) : (
          days.map((day) => (
            <DayGroup
              key={day.date}
              day={day}
              dismissed={dismissed}
              onDismiss={(id) => dismissMutation.mutate(id)}
              onSave={(id, saved) => saveMutation.mutate({ requestId: id, saved })}
            />
          ))
        )}
      </main>
    </div>
  );
}

// ── Day group ────────────────────────────────────────────────────────────────

function DayGroup({ day, dismissed, onDismiss, onSave }: {
  day: Day;
  dismissed: Set<string>;
  onDismiss: (id: string) => void;
  onSave: (id: string, saved: boolean) => void;
}) {
  const isToday = !!day.sections;

  return (
    <section style={{ marginBottom: 'var(--space-8)' }}>
      <h2 style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        padding: 'var(--space-3) 0 var(--space-3)',
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 'var(--space-4)',
      }}>
        {day.label}
      </h2>

      {isToday ? (
        day.sections!.map((section) => {
          const visible = section.cards.filter((c) => !dismissed.has(c.request_id));
          if (!visible.length) return null;
          return (
            <div key={section.id} style={{ marginBottom: 'var(--space-6)' }}>
              <p style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
                marginBottom: 'var(--space-3)',
                fontWeight: 500,
              }}>
                {section.label}
              </p>
              <CardList cards={visible} onDismiss={onDismiss} onSave={onSave} />
            </div>
          );
        })
      ) : (
        <CardList
          cards={day.cards.filter((c) => !dismissed.has(c.request_id))}
          onDismiss={onDismiss}
          onSave={onSave}
        />
      )}
    </section>
  );
}

function CardList({ cards, onDismiss, onSave }: {
  cards: FeedCard[];
  onDismiss: (id: string) => void;
  onSave: (id: string, saved: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <AnimatePresence mode="popLayout">
        {cards.map((row) => (
          <Card
            key={row.request_id}
            data={toCardData(row)}
            onDismiss={onDismiss}
            onSave={(id) => onSave(id, !!row.saved_at)}
          />
        ))}
      </AnimatePresence>
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
