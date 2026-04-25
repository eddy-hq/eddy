import React, { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Card, type CardData } from '../components/Card';
import { CompactCard, type SourceKind } from '../components/CompactCard';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import { BottomNav } from '../components/BottomNav';
import { AppHeader } from '../components/AppHeader';
import { useVideoSheet } from '../hooks/useVideoSheet';
import type { WatchSource } from '../lib/watchEvents';

// ── Discovery API ────────────────────────────────────────────────────────────

interface DiscoveryCandidate {
  candidateId: string;
  url: string;
  externalId: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  score: number | null;
  why: string | null;
  interestId: string | null;
  sourceType: string;
}

interface DiscoveryFeedResponse {
  candidates: DiscoveryCandidate[];
  coldStart: boolean;
  balancePrompt: {
    promptId: string;
    interestId: string;
    interestLabel: string;
    concentration: number;
  } | null;
}

async function fetchDiscoveryFeed(userId: string): Promise<DiscoveryFeedResponse> {
  const res = await fetch(`/discovery/feed?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load discovery feed');
  return res.json() as Promise<DiscoveryFeedResponse>;
}

async function dismissCandidate(userId: string, candidateId: string): Promise<void> {
  await fetch('/discovery/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, candidateId }),
  });
}

async function requestCandidate(userId: string, candidateId: string): Promise<void> {
  await fetch('/discovery/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, candidateId }),
  });
}

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
  thumbnail_url: string | null;
  duration_secs: number | null;
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
    status: row.status,
    fileState: row.file_state,
    nginxUrl: row.nginx_url,
    thumbnailUrl: row.thumbnail_url,
    durationSecs: row.duration_secs,
    requestedAt: row.requested_at,
    rejectionReason: row.rejection_reason,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
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
  const queryClient = useQueryClient();

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError } = useQuery({
    queryKey: ['feed', user],
    queryFn: () => fetchFeed(user),
    enabled: !!user,
    refetchInterval: 10_000,
  });

  const { data: discoveryData } = useQuery({
    queryKey: ['discovery-feed', user],
    queryFn: () => fetchDiscoveryFeed(user),
    enabled: !!user,
    staleTime: 5 * 60_000,
  });

  const handleDismiss = useCallback(async (candidateId: string) => {
    setDismissedIds((prev) => new Set([...prev, candidateId]));
    await dismissCandidate(user, candidateId).catch(() => {
      setDismissedIds((prev) => { const next = new Set(prev); next.delete(candidateId); return next; });
    });
  }, [user]);

  const handleAdd = useCallback(async (candidateId: string) => {
    setAddedIds((prev) => new Set([...prev, candidateId]));
    await requestCandidate(user, candidateId).catch(() => {
      setAddedIds((prev) => { const next = new Set(prev); next.delete(candidateId); return next; });
    });
    void queryClient.invalidateQueries({ queryKey: ['feed', user] });
  }, [user, queryClient]);

  if (!user) return <Empty text="No user selected." />;
  if (isLoading) return <Empty text="Loading…" />;
  if (isError) return <Empty text="Could not load." />;

  const allDays = data?.days ?? [];
  const todayDay = allDays.find((d) => d.label === 'Today') ?? null;
  const pastDays = allDays.filter((d) => d !== todayDay && (d.cards.length > 0 || d.sections?.some((s) => s.cards.length)));

  const visibleCandidates = (discoveryData?.candidates ?? []).filter(
    (c) => !dismissedIds.has(c.candidateId) && !addedIds.has(c.candidateId)
  );
  const showDiscovery = !!discoveryData;

  const hasAnyTodayContent =
    !!todayDay && ((todayDay.sections?.some((s) => s.cards.length) ?? false) || todayDay.cards.length > 0);
  const showEmpty = !showDiscovery && !hasAnyTodayContent && pastDays.length === 0;

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
              candidates={visibleCandidates}
              coldStart={discoveryData?.coldStart ?? false}
              showDiscovery={showDiscovery}
              selectedId={selectedCard?.requestId ?? null}
              onSelect={onSelect}
              onDismiss={handleDismiss}
              onAdd={handleAdd}
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
  todayDay, candidates, coldStart, showDiscovery,
  selectedId, onSelect, onDismiss, onAdd, userId,
}: {
  todayDay: Day | null;
  candidates: DiscoveryCandidate[];
  coldStart: boolean;
  showDiscovery: boolean;
  selectedId: string | null;
  onSelect: (data: CardData, source: WatchSource) => void;
  onDismiss: (id: string) => void;
  onAdd: (id: string) => void;
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

  const totalCount = requestsCards.length + followCards.length + pickedCards.length + candidates.length;

  // If today has no cards at all and discovery is cold, show nothing (caller handles empty state).
  if (totalCount === 0 && !showDiscovery) return null;

  // Heavy-follow days swap compact; otherwise hero.
  const followAsCompact = followCards.length > 6;

  const firstVoice = candidates[0]?.why ?? (pickedCards.length > 0 ? 'A few more you might like.' : null);

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

      {(pickedCards.length > 0 || candidates.length > 0) && (
        <>
          {firstVoice && <VoiceLine text={firstVoice} />}
          <CardList>
            {pickedCards.map((row) => (
              <Card
                key={row.request_id}
                data={toCardData(row)}
                userId={userId}
                onSelect={(c) => onSelect(c, 'discovery')}
                isSelected={selectedId === row.request_id}
                sourceKind="pick"
              />
            ))}
            <AnimatePresence mode="popLayout">
              {candidates.map((c, i) => (
                <React.Fragment key={c.candidateId}>
                  {i > 0 && c.why && <VoiceLine text={c.why} />}
                  <HeroDiscoveryCard candidate={c} onDismiss={onDismiss} onAdd={onAdd} />
                </React.Fragment>
              ))}
            </AnimatePresence>
          </CardList>
        </>
      )}

      {coldStart && pickedCards.length === 0 && candidates.length === 0 && (
        <div style={{ padding: '0 16px 18px' }}>
          <p style={{
            margin: 0, padding: '12px 14px', borderRadius: 10,
            background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
          }}>
            Eddy is still figuring out what you like — check back soon.
          </p>
        </div>
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

// ── Hero discovery card (tap-to-add, with dismiss) ───────────────────────────

function HeroDiscoveryCard({
  candidate, onDismiss, onAdd,
}: {
  candidate: DiscoveryCandidate;
  onDismiss: (id: string) => void;
  onAdd: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    if (adding) return;
    setAdding(true);
    await onAdd(candidate.candidateId);
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.22 }}
      onClick={handleAdd}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 16,
        overflow: 'hidden',
        background: 'var(--bg-surface)',
        boxShadow: 'var(--shadow-card)',
        border: '1px solid var(--border-subtle)',
        cursor: adding ? 'default' : 'pointer',
      }}
    >
      {/* Thumbnail */}
      <div style={{
        position: 'relative',
        aspectRatio: '16/9',
        overflow: 'hidden',
        background: '#2A2826',
      }}>
        {candidate.thumbnailUrl && (
          <img
            src={candidate.thumbnailUrl}
            alt=""
            loading="lazy"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}

        {/* Dismiss */}
        <button
          aria-label="Dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(candidate.candidateId); }}
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 3,
            width: 28, height: 28, borderRadius: '50%',
            background: 'rgba(0,0,0,0.55)', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: '#fff',
            backdropFilter: 'blur(4px)',
          }}
        >
          <X size={14} strokeWidth={2.5} />
        </button>
      </div>

      {/* Title + meta */}
      <div style={{ padding: '12px 14px 14px' }}>
        <h3 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 19, fontWeight: 500, lineHeight: 1.22,
          letterSpacing: '-0.008em', margin: '0 0 6px',
          color: 'var(--text-primary)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {candidate.title ?? candidate.url}
        </h3>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)',
          letterSpacing: '0.005em',
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
            color: 'var(--save)',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--save)' }} />
            Picked
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>·</span>
          <span>Tap to add</span>
        </div>
      </div>

      {adding && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 4,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(2px)',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', letterSpacing: '0.04em' }}>
            Adding…
          </span>
        </div>
      )}
    </motion.article>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{text}</p>
    </div>
  );
}
