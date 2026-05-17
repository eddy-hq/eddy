import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Card, type CardData } from '../components/Card';
import { CompactCard, type SourceKind } from '../components/CompactCard';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import { BottomNav } from '../components/BottomNav';
import { AppHeader } from '../components/AppHeader';
import { useVideoSheet } from '../hooks/useVideoSheet';
import { useRestorePolling } from '../hooks/useRestorePolling';
import type { WatchSource } from '../lib/watchEvents';

// ── Types ────────────────────────────────────────────────────────────────────

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

interface DaySection { id: string; label: string; cards: FeedCard[]; }

interface Day {
  date: string;
  label: string;
  cards: FeedCard[];
  sections?: DaySection[];
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
    youtubeChannelId: row.youtube_channel_id,
    status: row.status,
    fileState: row.file_state,
    nginxUrl: row.nginx_url,
    youtubeWatchUrl: row.url,
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

function sourceKind(src: string): SourceKind | null {
  if (src === 'share_sheet') return 'req';
  if (src === 'channel_subscription') return 'follow';
  if (src === 'recommended') return 'pick';
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────

export function Feed() {
  const [params] = useSearchParams();
  const { selectedCard, selectedSource, onSelect, onClose } = useVideoSheet();
  const user = params.get('userId') ?? params.get('user') ?? '';
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

  const allDays = data?.days ?? [];
  const todayDay = allDays.find((d) => d.label === 'Today') ?? null;
  const pastDays = allDays.filter((d) => d !== todayDay && (d.cards.length > 0 || d.sections?.some((s) => s.cards.length)));

  const hasAnyTodayContent =
    !!todayDay && ((todayDay.sections?.some((s) => s.cards.length) ?? false) || todayDay.cards.length > 0);
  const showEmpty = !hasAnyTodayContent && pastDays.length === 0;

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-primary)' }}>

      {/* Sticky chrome */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)' }}>
        <AppHeader />
      </div>

      {/* Feed content */}
      <main style={{ paddingBottom: 100 }}>
        {showEmpty ? (
          <div style={{ paddingTop: 64, textAlign: 'center', padding: '64px 32px 0' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)', margin: 0 }}>
              Nothing here yet. Share a YouTube link to get started.
            </p>
          </div>
        ) : (
          <>
            <TodayBlock
              todayDay={todayDay}
              selectedId={selectedCard?.requestId ?? null}
              onSelect={onSelect}
              userId={user}
            />
            {pastDays.map((day) => (
              <PastDayBlock
                key={day.date}
                day={day}
                onSelect={onSelect}
                userId={user}
              />
            ))}
          </>
        )}
      </main>

      <BottomNav />

      <AnimatePresence>
        {selectedCard && (
          <VideoDetailSheet
            key={selectedCard.requestId}
            card={selectedCard}
            userId={user}
            source={selectedSource ?? 'feed'}
            onClose={onClose}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Today block — Tier 1 ─────────────────────────────────────────────────────

function TodayBlock({
  todayDay, selectedId, onSelect, userId,
}: {
  todayDay: Day | null;
  selectedId: string | null;
  onSelect: (data: CardData, source: WatchSource) => void;
  userId: string;
}) {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  // Sections from server come as requests/channels/recommended. Falls back to flat cards.
  const sections = todayDay?.sections ?? [];
  const reqSection = sections.find((s) => s.id === 'requests');
  const followSection = sections.find((s) => s.id === 'channels');
  const pickSection = sections.find((s) => s.id === 'recommended');

  const requestsCards = reqSection?.cards ?? [];
  const followCards = followSection?.cards ?? [];
  const pickedCards = pickSection?.cards ?? [];

  const totalCount = requestsCards.length + followCards.length + pickedCards.length;

  if (totalCount === 0) return null;

  // Heavy-follow days swap compact; otherwise hero.
  const followAsCompact = followCards.length > 6;

  return (
    <section>
      <DayLabelToday date={formattedDate} count={totalCount || null} />

      {requestsCards.length > 0 && (
        <>
          <SectionHeader label="You asked" count={requestsCards.length} />
          <CardList>
            <AnimatePresence mode="popLayout">
              {requestsCards.map((row) => (
                <Card
                  key={row.request_id}
                  data={toCardData(row)}
                  userId={userId}
                  onSelect={(c) => onSelect(c, 'feed')}
                  isSelected={selectedId === row.request_id}
                  sourceKind="req"
                />
              ))}
            </AnimatePresence>
          </CardList>
        </>
      )}

      {followCards.length > 0 && (
        <>
          <SectionHeader label="From people you follow" count={followCards.length} />
          {followAsCompact ? (
            <CompactList>
              <AnimatePresence mode="popLayout">
                {followCards.map((row) => (
                  <CompactCard
                    key={row.request_id}
                    data={toCardData(row)}
                    userId={userId}
                    sourceKind="follow"
                    onSelect={(c) => onSelect(c, 'feed')}
                  />
                ))}
              </AnimatePresence>
            </CompactList>
          ) : (
            <CardList>
              <AnimatePresence mode="popLayout">
                {followCards.map((row) => (
                  <Card
                    key={row.request_id}
                    data={toCardData(row)}
                    userId={userId}
                    onSelect={(c) => onSelect(c, 'feed')}
                    isSelected={selectedId === row.request_id}
                    sourceKind="follow"
                  />
                ))}
              </AnimatePresence>
            </CardList>
          )}
        </>
      )}

      {pickedCards.length > 0 && (
        <AnimatePresence mode="popLayout">
          {pickedCards.map((row) => (
            <PickWithVoice
              key={row.request_id}
              row={row}
              userId={userId}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </AnimatePresence>
      )}

      <EndToday />
    </section>
  );
}

// ── Past-day block — Tier 2 (recent past, compact cards) ─────────────────────

function PastDayBlock({
  day, onSelect, userId,
}: {
  day: Day;
  onSelect: (data: CardData, source: WatchSource) => void;
  userId: string;
}) {
  const lbl = day.label;
  const isYesterday = lbl.toLowerCase() === 'yesterday';
  const dateObj = new Date(day.date + 'T12:00:00');
  const weekday = dateObj.toLocaleDateString('en-GB', { weekday: 'long' });
  const dayMonth = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const cards = day.sections?.length ? day.sections.flatMap((s) => s.cards) : day.cards;
  if (cards.length === 0) return null;

  return (
    <section>
      <DayLabelPast
        main={isYesterday ? 'Yesterday' : weekday}
        ago={isYesterday ? 'yesterday' : dayMonth}
        count={cards.length}
      />
      <CompactList>
        <AnimatePresence mode="popLayout">
          {cards.map((row) => (
            <CompactCard
              key={row.request_id}
              data={toCardData(row)}
              userId={userId}
              sourceKind={sourceKind(row.source)}
              onSelect={(c) => onSelect(c, 'history')}
            />
          ))}
        </AnimatePresence>
      </CompactList>
    </section>
  );
}

// ── Timeline building blocks ─────────────────────────────────────────────────

function DayLabelToday({ date, count }: { date: string; count: number | null }) {
  return (
    <div style={{ padding: '20px 22px 16px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
        color: 'var(--text-primary)',
      }}>
        Today
      </span>
      <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.02em', color: 'var(--text-tertiary)' }}>
        {date}
      </span>
      {count != null && count > 0 && (
        <span style={{
          marginLeft: 'auto', fontFamily: 'var(--font-serif)', fontStyle: 'italic',
          fontSize: 12, color: 'var(--text-secondary)',
        }}>
          {count} {count === 1 ? 'item' : 'items'}
        </span>
      )}
    </div>
  );
}

function DayLabelPast({ main, ago, count }: { main: string; ago: string; count: number }) {
  return (
    <div style={{ padding: '28px 22px 14px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{
        fontFamily: 'var(--font-serif)', fontWeight: 500,
        fontSize: 14, color: 'var(--text-primary)', letterSpacing: '-0.005em',
      }}>
        {main}
      </span>
      <span style={{
        fontFamily: 'var(--font-serif)', fontStyle: 'italic',
        fontSize: 11, color: 'var(--text-tertiary)',
      }}>
        · {ago} · {count} {count === 1 ? 'item' : 'items'}
      </span>
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ padding: '18px 22px 10px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{
        fontFamily: 'var(--font-serif)', fontWeight: 500,
        fontSize: 15, color: 'var(--text-primary)', letterSpacing: '-0.003em',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-serif)', fontStyle: 'italic',
        fontSize: 12, color: 'var(--text-secondary)',
      }}>
        {count}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)', marginLeft: 8 }} />
    </div>
  );
}

// One pick = one voice line (Eddy's why_text in first-person prose) plus
// its hero card. Picks are not grouped under a "Picked for you" header —
// the voice line is the introduction. Brief §9a + design/Eddy Feed.html.
function PickWithVoice({
  row, userId, selectedId, onSelect,
}: {
  row: FeedCard;
  userId: string;
  selectedId: string | null;
  onSelect: (data: CardData, source: WatchSource) => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
    >
      {row.why_text && <VoiceLine text={row.why_text} />}
      <CardList>
        <Card
          data={toCardData(row)}
          userId={userId}
          onSelect={(c) => onSelect(c, 'discovery')}
          isSelected={selectedId === row.request_id}
          sourceKind="pick"
        />
      </CardList>
    </motion.div>
  );
}

function VoiceLine({ text }: { text: string }) {
  return (
    <p style={{
      margin: '18px 16px 10px',
      padding: '4px 0 6px',
      fontFamily: 'var(--font-serif)',
      fontStyle: 'italic',
      fontWeight: 400,
      fontSize: 15,
      lineHeight: 1.5,
      letterSpacing: '-0.002em',
      color: 'var(--text-primary)',
    }}>
      {text}
    </p>
  );
}

function EndToday() {
  return (
    <div style={{
      margin: '24px 22px 8px',
      padding: '16px 0 14px',
      textAlign: 'center',
      fontFamily: 'var(--font-serif)',
      fontStyle: 'italic',
      fontSize: 13,
      color: 'var(--text-tertiary)',
      borderBottom: '1px dashed var(--border-subtle)',
      letterSpacing: '0.005em',
    }}>
      That's Today.
    </div>
  );
}

function CardList({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px' }}>
      {children}
    </div>
  );
}

function CompactList({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 16px' }}>
      {children}
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
