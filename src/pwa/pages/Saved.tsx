import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { Card, type CardData } from '../components/Card';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import { BottomNav } from '../components/BottomNav';
import { AppHeader } from '../components/AppHeader';
import { useVideoSheet } from '../hooks/useVideoSheet';
import { useRestorePolling } from '../hooks/useRestorePolling';

interface FeedCard {
  request_id: string;
  title: string | null;
  channel: string | null;
  youtube_id: string | null;
  youtube_channel_id: string | null;
  url: string;
  status: string;
  file_state: string;
  nginx_url: string | null;
  thumbnail_url: string | null;
  duration_secs: number | null;
  why_text: string | null;
  rejection_reason: string | null;
  requested_at: string;
  added_at: string;
  watched_at: string | null;
  saved_at: string | null;
  source: string;
}

interface FeedResponse { days: { date: string; label: string; cards: FeedCard[]; sections?: { id: string; label: string; cards: FeedCard[] }[] }[]; }

async function fetchFeed(user: string): Promise<FeedResponse> {
  const param = /^[0-9a-f-]{36}$/.test(user) ? 'userId' : 'user';
  const res = await fetch(`/requests/feed?${param}=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error('Failed to load');
  return res.json() as Promise<FeedResponse>;
}

function toCardData(row: FeedCard): CardData {
  return {
    requestId: row.request_id,
    title: row.title ?? row.url,
    channel: row.channel,
    youtubeId: row.youtube_id,
    youtubeChannelId: row.youtube_channel_id,
    status: row.status,
    fileState: row.file_state,
    nginxUrl: row.nginx_url,
    thumbnailUrl: row.thumbnail_url,
    durationSecs: row.duration_secs,
    whyText: row.why_text,
    requestedAt: row.requested_at,
    rejectionReason: row.rejection_reason,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
    source: row.source,
  };
}

function groupByPeriod(cards: FeedCard[]): { thisWeek: FeedCard[]; earlier: FeedCard[] } {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek: FeedCard[] = [];
  const earlier: FeedCard[] = [];
  for (const c of cards) {
    if (new Date(c.saved_at!).getTime() >= cutoff) thisWeek.push(c);
    else earlier.push(c);
  }
  return { thisWeek, earlier };
}

export function Saved() {
  const [params] = useSearchParams();
  const user = params.get('userId') ?? params.get('user') ?? '';
  const { selectedCard, selectedSource, onSelect, onClose } = useVideoSheet();
  useRestorePolling();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['feed', user],
    queryFn: () => fetchFeed(user),
    enabled: !!user,
    refetchInterval: 10_000,
  });

  if (!user) return <Empty text="No user selected." />;
  if (isLoading) return <Empty text="Loading…" />;
  if (isError) return <Empty text="Could not load." />;

  const allCards = (data?.days ?? [])
    .flatMap(d => d.sections ? d.sections.flatMap(s => s.cards) : d.cards)
    .filter(c => !!c.saved_at)
    .sort((a, b) => new Date(b.saved_at!).getTime() - new Date(a.saved_at!).getTime());

  const { thisWeek, earlier } = groupByPeriod(allCards);
  const total = allCards.length;

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>

      {/* Sticky header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)' }}>
        <AppHeader />
      </div>

      {/* Page title */}
      <div style={{ padding: '20px 22px 4px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 400, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>
          Saved
        </h1>
        {total > 0 && (
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.02em' }}>
            {total} {total === 1 ? 'item' : 'items'}
          </span>
        )}
      </div>
      <p style={{ padding: '0 22px 14px', fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic', fontFamily: 'var(--font-serif)', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4 }}>
        Kept so they don't get recycled. Reverse-chronological by save date.
      </p>

      {/* Saved content */}
      <div style={{ paddingBottom: 100 }}>
        {total === 0 ? (
          <div style={{ paddingTop: 64, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
              Nothing saved yet. Tap the bookmark on any video to save it.
            </p>
          </div>
        ) : (
          <>
            {thisWeek.length > 0 && (
              <section>
                <div style={{ padding: '16px 20px 6px', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                  This week
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 16px 0' }}>
                  <AnimatePresence mode="popLayout">
                    {thisWeek.map(row => (
                      <Card
                        key={row.request_id}
                        data={toCardData(row)}
                        userId={user}
                        onSelect={(c) => onSelect(c, 'saved')}
                        isSelected={selectedCard?.requestId === row.request_id}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            )}
            {earlier.length > 0 && (
              <section>
                <div style={{ padding: '16px 20px 6px', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                  Earlier
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 16px 0' }}>
                  <AnimatePresence mode="popLayout">
                    {earlier.map(row => (
                      <Card
                        key={row.request_id}
                        data={toCardData(row)}
                        userId={user}
                        onSelect={(c) => onSelect(c, 'saved')}
                        isSelected={selectedCard?.requestId === row.request_id}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <BottomNav />

      <AnimatePresence>
        {selectedCard && (
          <VideoDetailSheet
            key={selectedCard.requestId}
            card={selectedCard}
            userId={user}
            source={selectedSource ?? 'saved'}
            onClose={onClose}
          />
        )}
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
