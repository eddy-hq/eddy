import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Card, type CardData } from '../components/Card';
import { CompactCard, type SourceKind } from '../components/CompactCard';
import { VideoDetailSheet } from '../components/VideoDetailSheet';
import { BottomNav } from '../components/BottomNav';
import { AppHeader } from '../components/AppHeader';
import { useVideoSheet } from '../hooks/useVideoSheet';
import { useRestorePolling } from '../hooks/useRestorePolling';
import type { WatchSource } from '../lib/watchEvents';
import {
  ageInDays,
  agoLabel,
  isQuiet,
  isTier2Age,
  itemsLabel,
  moreCount,
  provenanceSegments,
} from './feed-tier3';

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

// Tier 3 (per-day) and Tier 4 (per-week) summaries for older history. Additive
// fields on the /feed payload (issue #140); rendered by sub-issues #141/#142.
// `tier4Weeks[].summary` is null until the Gemma sub-issue (#143) populates it.
interface Tier3Day {
  date: string;
  count: number;
  provenanceMix: { req: number; follow: number; pick: number };
  topTitles: Array<{ title: string; kind: 'req' | 'follow' | 'pick' }>;
}

interface Tier4Week {
  rangeStart: string;
  rangeEnd: string;
  count: number;
  topChannels: string[];
  summary: string | null;
}

interface FeedResponse {
  days: Day[];
  tier3Days?: Tier3Day[];
  tier4Weeks?: Tier4Week[];
}

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

// Provenance colour map — kept literally in sync with the CompactCard DOT map
// (and index.css). Used by the Tier 3 day-row's provenance bar + title dots.
const PROVENANCE_DOT: Record<'req' | 'follow' | 'pick', string> = {
  req: '#B8863C',          // amber-gold
  follow: 'var(--accent)', // teal
  pick: 'var(--save)',     // save green
};

// Today as a 'YYYY-MM-DD' string on the **UTC** calendar, for client-side tier
// bucketing. The server buckets with `new Date().toISOString().slice(0, 10)`
// (UTC) in src/modules/requests/index.ts, so the client must use the same UTC
// basis — using the local date instead would, in non-UTC offsets between local
// and UTC midnight, shift every age by a day and make a server age-6 day (still
// in `days`, never in `tier3Days`) vanish from both tiers.
function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
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

  const today = todayDateStr();
  const allDays = data?.days ?? [];
  const todayDay = allDays.find((d) => d.label === 'Today') ?? null;
  const populatedPastDays = allDays.filter(
    (d) => d !== todayDay && (d.cards.length > 0 || d.sections?.some((s) => s.cards.length)),
  );

  // Tier 2: only days less than 7 calendar days old (yesterday … 6 days ago).
  // Older history is summarised by Tier 3 (7–29d) day-rows and Tier 4 weeks.
  const pastDays = populatedPastDays.filter((d) => isTier2Age(ageInDays(d.date, today)));

  // Tier 3 day-rows come from the additive `tier3Days` summary (#140). On
  // expand each row looks up its full card rows by date in `days`; days beyond
  // FEED_LIMIT have no match and degrade to the peek-only view.
  const tier3Days = data?.tier3Days ?? [];
  const daysByDate = new Map(allDays.map((d) => [d.date, d]));

  const hasAnyTodayContent =
    !!todayDay && ((todayDay.sections?.some((s) => s.cards.length) ?? false) || todayDay.cards.length > 0);
  const showEmpty = !hasAnyTodayContent && pastDays.length === 0 && tier3Days.length === 0;

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

            {/* Tier 3 — collapsed day-rows for 7–29d history. */}
            {tier3Days.map((t3) => (
              <DayRow
                key={t3.date}
                day={t3}
                age={ageInDays(t3.date, today)}
                matchedDay={daysByDate.get(t3.date) ?? null}
                onSelect={onSelect}
                userId={user}
              />
            ))}

            {/* Tier 4 (week-rows + month markers) slots in here — sibling #142. */}
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

  // Two stretches (ADR-0009): "You asked" (share-sheet requests) then a
  // unified Today stream mixing follow + pick cards, each carrying its own
  // provenance pill. Server sends `requests` + `today` sections; fall back to
  // splitting flat cards by source for older payloads.
  const sections = todayDay?.sections ?? [];
  const reqSection = sections.find((s) => s.id === 'requests');
  const todaySection = sections.find((s) => s.id === 'today');

  const flatCards = todayDay?.cards ?? [];
  const requestsCards = reqSection?.cards
    ?? flatCards.filter((c) => c.source === 'share_sheet');
  const todayCards = todaySection?.cards
    ?? flatCards.filter((c) => c.source === 'channel_subscription' || c.source === 'recommended');

  const totalCount = requestsCards.length + todayCards.length;

  if (totalCount === 0) return null;

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

      {todayCards.length > 0 && (
        <>
          <SectionHeader label="Today" count={todayCards.length} />
          <AnimatePresence mode="popLayout">
            {todayCards.map((row) => (
              <TodayStreamCard
                key={row.request_id}
                row={row}
                userId={userId}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </AnimatePresence>
        </>
      )}

      <EndToday />
    </section>
  );
}

// One card in the unified Today stream. Every card carries its Eddy voice
// line (why_text) as its introduction — scoring writes one for follows,
// back-catalogue and picks alike (brief §9a) — and the always-hero pick
// treatment is dropped (ADR-0009). Both carry a provenance pill via
// `sourceKind` so the source is legible without a section header.
function TodayStreamCard({
  row, userId, selectedId, onSelect,
}: {
  row: FeedCard;
  userId: string;
  selectedId: string | null;
  onSelect: (data: CardData, source: WatchSource) => void;
}) {
  const kind = sourceKind(row.source);
  const isPick = kind === 'pick';
  const watchSource: WatchSource = isPick ? 'discovery' : 'feed';
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
          onSelect={(c) => onSelect(c, watchSource)}
          isSelected={selectedId === row.request_id}
          sourceKind={kind}
        />
      </CardList>
    </motion.div>
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

// ── Day row — Tier 3 (collapsed summary, expands to compact cards) ───────────

// One Tier 3 day. Collapsed it shows a vertical provenance bar, the date / ago
// / count, a 3-title peek with provenance dots, and a chevron. Tapping expands
// inline: the matched full day (looked up by date in `days`) renders its rows
// via the existing CompactCard. Rows older than ~14d dim (quiet variant). The
// component stays thin — proportions, "+N more", quiet threshold and the ago
// string come from ./feed-tier3 (unit-tested). AnimatePresence wraps the
// expanded body so a future open/close transition slots straight in.
function DayRow({
  day, age, matchedDay, onSelect, userId,
}: {
  day: Tier3Day;
  age: number;
  matchedDay: Day | null;
  onSelect: (data: CardData, source: WatchSource) => void;
  userId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const quiet = isQuiet(age);

  const dateObj = new Date(day.date + 'T12:00:00');
  const dateLabel = dateObj.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const peek = day.topTitles.slice(0, 3);
  const more = moreCount(day.count, peek.length);
  const segments = provenanceSegments(day.provenanceMix);

  const expandedCards = matchedDay
    ? (matchedDay.sections?.length ? matchedDay.sections.flatMap((s) => s.cards) : matchedDay.cards)
    : [];
  const canExpand = expandedCards.length > 0;

  return (
    <div style={{ margin: '0 14px 6px' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => { if (canExpand) setExpanded((v) => !v); }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && canExpand) { e.preventDefault(); setExpanded((v) => !v); }
        }}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 12,
          padding: '12px 14px',
          borderRadius: 12,
          border: '1px solid',
          borderColor: expanded ? 'var(--border-subtle)' : 'transparent',
          background: expanded ? 'var(--bg-surface)' : 'transparent',
          cursor: canExpand ? 'pointer' : 'default',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {/* Provenance bar — segments stacked follow / req / pick, heights ∝ counts */}
        <div
          aria-hidden
          style={{
            width: 4,
            flexShrink: 0,
            alignSelf: 'stretch',
            minHeight: 56,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            borderRadius: 999,
            overflow: 'hidden',
            background: '#E6E3DB', // faint neutral track (no global token; nearest --bg-elevated is too light here)
            opacity: quiet ? 0.62 : 1,
          }}
        >
          {segments.map((seg) => (
            <div
              key={seg.kind}
              style={{
                width: '100%',
                flex: `${seg.grow} 0 auto`,
                minHeight: seg.grow > 0 ? 6 : 0,
                background: PROVENANCE_DOT[seg.kind],
              }}
            />
          ))}
        </div>

        {/* Info column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <span style={{
              fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 14,
              color: 'var(--text-primary)', letterSpacing: '-0.005em',
            }}>
              {dateLabel}
            </span>
            <span style={{
              fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 11,
              color: 'var(--text-tertiary)',
            }}>
              {agoLabel(age)}
            </span>
            <span style={{
              marginLeft: 'auto', fontFamily: 'var(--font-sans)', fontSize: 10.5, fontWeight: 600,
              letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)',
            }}>
              {itemsLabel(day.count)}
            </span>
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {peek.map((t, i) => (
              <li
                key={`${t.kind}-${i}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontFamily: 'var(--font-sans)', fontSize: 11.5, lineHeight: 1.3, fontWeight: 500,
                  letterSpacing: '-0.001em',
                  color: quiet ? 'var(--text-secondary)' : 'var(--text-primary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                <span style={{
                  flexShrink: 0, width: 5, height: 5, borderRadius: '50%',
                  background: PROVENANCE_DOT[t.kind],
                }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
              </li>
            ))}
            {more > 0 && (
              <li style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: 'var(--font-sans)', fontSize: 11.5, lineHeight: 1.3, fontWeight: 500,
                color: 'var(--text-tertiary)',
              }}>
                <span style={{ flexShrink: 0, width: 5 }} />
                <span>+ {more} more</span>
              </li>
            )}
          </ul>
        </div>

        {/* Chevron — rotates 90° when expanded */}
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          aria-hidden
          style={{
            flexShrink: 0,
            alignSelf: 'flex-start',
            marginTop: 2,
            color: 'var(--text-tertiary)',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 180ms ease',
            visibility: canExpand ? 'visible' : 'hidden',
          }}
        />
      </div>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.33, 1, 0.68, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 14px' }}>
              {expandedCards.map((row) => (
                <CompactCard
                  key={row.request_id}
                  data={toCardData(row)}
                  userId={userId}
                  sourceKind={sourceKind(row.source)}
                  onSelect={(c) => onSelect(c, 'history')}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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

function Empty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{text}</p>
    </div>
  );
}
