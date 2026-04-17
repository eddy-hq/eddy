import React, { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { Card, type CardData } from '../components/Card';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import { BottomNav } from '../components/BottomNav';
import { AppHeader } from '../components/AppHeader';

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

interface Day {
  date: string;
  label: string;
  cards: FeedCard[];
  sections?: { id: string; label: string; cards: FeedCard[] }[];
}

interface FeedResponse { days: Day[]; }

// ── API ──────────────────────────────────────────────────────────────────────

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
    status: row.status,
    fileState: row.file_state,
    nginxUrl: row.nginx_url,
    requestedAt: row.requested_at,
    rejectionReason: row.rejection_reason,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
  };
}

// ── Scroll-direction hook ────────────────────────────────────────────────────

function useScrollDirection(threshold = 6) {
  const [chipsVisible, setChipsVisible] = useState(true);
  const lastY = useRef(0);

  useEffect(() => {
    function onScroll() {
      const y = window.scrollY;
      const delta = y - lastY.current;
      lastY.current = y;
      if (delta > threshold && y > 80) setChipsVisible(false);
      if (delta < -threshold) setChipsVisible(true);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);

  return chipsVisible;
}

// ── Component ────────────────────────────────────────────────────────────────

const CHIPS_H = 54; // px — padding 12 top/bottom + chip ~30

export function Feed() {
  const [params] = useSearchParams();
  const [activeChip, setActiveChip] = useState('All');
  const [selectedCard, setSelectedCard] = useState<CardData | null>(null);
  const chipsVisible = useScrollDirection();
  const user = params.get('userId') ?? params.get('user') ?? '';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['feed', user],
    queryFn: () => fetchFeed(user),
    enabled: !!user,
    refetchInterval: 10_000,
  });

  if (!user) return <Empty text="No user selected." />;
  if (isLoading) return <Empty text="Loading…" />;
  if (isError) return <Empty text="Could not load." />;

  const days = (data?.days ?? []).filter((d) => d.cards.length > 0 || d.sections?.some(s => s.cards.length));
  const hasContent = days.length > 0;

  function dayCards(day: Day): FeedCard[] {
    if (day.sections?.length) return day.sections.flatMap(s => s.cards);
    return day.cards;
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>

      {/* Sticky chrome */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)' }}>

        {/* App header — always visible */}
        <AppHeader borderBottom={!chipsVisible} />

        {/* Topic chips — collapses on scroll-down */}
        <div style={{
          maxHeight: chipsVisible ? CHIPS_H : 0,
          opacity: chipsVisible ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height 240ms ease, opacity 180ms ease',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div style={{
            padding: '12px 18px',
            overflowX: 'auto', scrollbarWidth: 'none',
            display: 'flex', gap: 7, alignItems: 'center',
            WebkitOverflowScrolling: 'touch',
          }}>
            {['All', 'Minecraft', 'Science', 'Football', 'Space', 'Music'].map((chip) => (
              <button
                key={chip}
                onClick={() => setActiveChip(chip)}
                style={{
                  flexShrink: 0,
                  fontSize: 12, fontWeight: activeChip === chip ? 600 : 500,
                  letterSpacing: '0.01em',
                  padding: '7px 13px', borderRadius: 20,
                  background: activeChip === chip ? 'var(--accent)' : 'transparent',
                  color: activeChip === chip ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${activeChip === chip ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Feed content */}
      <main style={{ paddingBottom: 100 }}>
        {!hasContent ? (
          <div style={{ paddingTop: 64, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
              Nothing here yet. Share a YouTube link to get started.
            </p>
          </div>
        ) : (
          days.map((day, i) => (
            <DayGroup
              key={day.date}
              day={day}
              cards={dayCards(day)}
              showDivider={i > 0}
              selectedId={selectedCard?.requestId ?? null}
              onSelect={setSelectedCard}
            />
          ))
        )}
      </main>

      <BottomNav />

      <AnimatePresence>
        {selectedCard && (
          <VideoDetailSheet
            key={selectedCard.requestId}
            card={selectedCard}
            onClose={() => setSelectedCard(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Day group ────────────────────────────────────────────────────────────────

function DayGroup({
  day, cards, showDivider, selectedId, onSelect,
}: {
  day: Day;
  cards: FeedCard[];
  showDivider: boolean;
  selectedId: string | null;
  onSelect: (data: CardData) => void;
}) {
  const lbl = day.label;
  const dateObj = new Date(day.date + 'T12:00:00');
  const isToday     = lbl.toLowerCase() === 'today';
  const isYesterday = lbl.toLowerCase() === 'yesterday';
  const formattedDate = dateObj.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <section>
      {showDivider && (
        <div style={{ margin: '4px 20px 16px', height: 1, background: 'var(--border-subtle)' }} />
      )}
      <div style={{ padding: '22px 20px 14px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>
          {lbl}
        </span>
        {(isToday || isYesterday) && (
          <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.02em', color: 'var(--text-tertiary)' }}>
            {formattedDate}
          </span>
        )}
        {isToday && cards.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.02em' }}>
            {cards.length} {cards.length === 1 ? 'request' : 'requests'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 16px' }}>
        <AnimatePresence mode="popLayout">
          {cards.map((row) => (
            <Card
              key={row.request_id}
              data={toCardData(row)}
              onSelect={onSelect}
              isSelected={selectedId === row.request_id}
            />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{text}</p>
    </div>
  );
}
