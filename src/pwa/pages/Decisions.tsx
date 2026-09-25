import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ExternalLink, SkipForward, X } from 'lucide-react';
import {
  SOURCE_LABEL,
  agreement,
  decisionsForCard,
  effectLabel,
  formatScores,
  keyAction,
  removeDecided,
  skipCard,
  verdictLabel,
  type DecisionCard,
  type DecisionOutcome,
  type DecisionQueue,
  type HumanVerdict,
  type ShownEval,
} from '../lib/decisions';

// Decisions (Phase 6a): Escalations and Spot checks for a parent. Opened as
// /decisions?userId=<parent id>; the server refuses any non-parent id.

type Mode = 'today' | 'catch_up';
type Focus = 'escalations' | 'spot_checks';

async function fetchQueue(userId: string, mode: Mode, focus: Focus): Promise<DecisionQueue> {
  const params = new URLSearchParams({ userId, mode });
  if (mode === 'catch_up') params.set('focus', focus);
  const res = await fetch(`/parent/decisions/queue?${params.toString()}`);
  if (res.status === 403) throw new Error('Decisions are for parents only.');
  if (!res.ok) throw new Error(`Could not load decisions (${res.status})`);
  return res.json() as Promise<DecisionQueue>;
}

async function postDecisions(
  userId: string,
  decisions: ReturnType<typeof decisionsForCard>,
): Promise<DecisionOutcome[]> {
  const res = await fetch('/parent/decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, decisions }),
  });
  if (!res.ok) throw new Error(`Could not record the decision (${res.status})`);
  return ((await res.json()) as { outcomes: DecisionOutcome[] }).outcomes;
}

interface Reveal {
  card: DecisionCard;
  verdict: HumanVerdict;
  outcomes: DecisionOutcome[];
}

// ── Pieces ───────────────────────────────────────────────────────────────────

const pill = (colour: string): React.CSSProperties => ({
  fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  padding: '3px 8px', borderRadius: 20, color: colour, background: `${colour}1A`, whiteSpace: 'nowrap',
});

function Segmented<T extends string>({ options, value, onChange }: {
  options: Array<[T, string]>; value: T; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', padding: 3 }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            flex: 1, border: 'none', cursor: 'pointer', padding: '7px 10px',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', fontWeight: 600,
            background: value === v ? 'var(--bg-surface)' : 'transparent',
            color: value === v ? 'var(--text-primary)' : 'var(--text-secondary)',
            boxShadow: value === v ? 'var(--shadow-card)' : 'none',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function GuardPanel({ guard, title }: { guard: ShownEval; title: string }) {
  const scores = formatScores(guard.scores);
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {title}: {verdictLabel(guard.verdict)}
      </div>
      {guard.reason && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', lineHeight: 1.45 }}>{guard.reason}</p>}
      {scores.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 4 }}>
          {scores.map((s) => (
            <span key={s.label} style={{ fontSize: 'var(--text-xs)', color: s.high ? 'var(--dismiss)' : 'var(--text-secondary)', fontWeight: s.high ? 700 : 500 }}>
              {s.label} {s.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function VideoSummary({ card }: { card: DecisionCard }) {
  const [expanded, setExpanded] = useState(false);
  const long = card.description.length > 180;
  return (
    <>
      <a href={card.url} target="_blank" rel="noreferrer" style={{ display: 'block', position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-elevated)', aspectRatio: '16 / 9' }}>
        {card.thumbnailUrl && <img src={card.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
        <span style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 'var(--text-xs)', padding: '4px 8px', borderRadius: 20 }}>
          <ExternalLink size={12} /> Watch
        </span>
      </a>
      <div>
        <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-lg)', lineHeight: 1.25, color: 'var(--text-primary)' }}>{card.title}</h2>
        {card.channel && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 4 }}>{card.channel}</p>}
      </div>
      {card.description && (
        <p
          onClick={() => setExpanded((e) => !e)}
          style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.45, cursor: long ? 'pointer' : 'default', whiteSpace: 'pre-wrap' }}
        >
          {long && !expanded ? `${card.description.slice(0, 180)}… more` : card.description}
        </p>
      )}
    </>
  );
}

const actionButton = (colour: string, filled: boolean): React.CSSProperties => ({
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '12px 10px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  fontSize: 'var(--text-base)', fontWeight: 600,
  border: filled ? 'none' : '1px solid var(--border-subtle)',
  background: filled ? colour : 'var(--bg-surface)',
  color: filled ? '#fff' : 'var(--text-primary)',
});

// ── Page ─────────────────────────────────────────────────────────────────────

export function Decisions() {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? '';
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('today');
  const [focus, setFocus] = useState<Focus>('escalations');
  const [cards, setCards] = useState<DecisionCard[]>([]);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryKey = ['decisions', userId, mode, focus];
  const { data, isLoading, error: loadError, dataUpdatedAt } = useQuery({
    queryKey,
    queryFn: () => fetchQueue(userId, mode, focus),
    enabled: !!userId,
    staleTime: 0,
    // Coming back from the Watch link must not reset the local queue.
    refetchOnWindowFocus: false,
  });

  // A fresh fetch replaces the local queue (skips and decisions included).
  useEffect(() => {
    if (data) setCards(data.cards);
  }, [data, dataUpdatedAt]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const current = cards[0] ?? null;

  const refetchIfEmpty = useCallback((next: DecisionCard[]) => {
    if (next.length === 0) void queryClient.invalidateQueries({ queryKey: ['decisions', userId] });
  }, [queryClient, userId]);

  const decide = useCallback(async (verdict: HumanVerdict, onlyUserId?: string) => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcomes = await postDecisions(userId, decisionsForCard(current, verdict, onlyUserId));
      const decided = new Set(outcomes.map((o) => o.subjectId));
      const next = removeDecided(cards, decided);
      setCards(next);
      if (current.source === 'escalation') {
        setFlash(outcomes.map((o) => effectLabel(o.effect)).filter((v, i, a) => a.indexOf(v) === i).join(' · '));
        refetchIfEmpty(next);
      } else {
        // Spot check: show what the guard said before moving on.
        setReveal({ card: current, verdict, outcomes });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, [current, busy, userId, cards, refetchIfEmpty]);

  const skip = useCallback(() => {
    if (current) setCards((cs) => skipCard(cs, current.key));
  }, [current]);

  const next = useCallback(() => {
    setReveal(null);
    refetchIfEmpty(cards);
  }, [cards, refetchIfEmpty]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = keyAction(e.key, reveal !== null);
      if (!action) return;
      e.preventDefault();
      if (action === 'allow') void decide('clear_yes');
      else if (action === 'block') void decide('clear_no');
      else if (action === 'skip') skip();
      else next();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, skip, next, reveal]);

  if (!userId) {
    return <Shell><p style={{ color: 'var(--text-secondary)' }}>Open this page with <code>?userId=</code> set to a parent's id.</p></Shell>;
  }

  const counts = data?.counts;
  const multi = (current?.subjects.length ?? 0) > 1;

  return (
    <Shell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Segmented<Mode> options={[['today', 'Today'], ['catch_up', 'Catch-up']]} value={mode} onChange={(m) => { setReveal(null); setMode(m); }} />
        {mode === 'catch_up' && (
          <Segmented<Focus> options={[['escalations', 'Escalations'], ['spot_checks', 'Spot checks']]} value={focus} onChange={(f) => { setReveal(null); setFocus(f); }} />
        )}
        {counts && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            {counts.escalations} escalations waiting ({counts.escalationsRecent} from the last 14 days) · {counts.spotChecksToday} spot checks left today
          </p>
        )}
      </div>

      {error && <p style={{ color: 'var(--dismiss)', fontSize: 'var(--text-sm)' }}>{error}</p>}
      {loadError && <p style={{ color: 'var(--dismiss)', fontSize: 'var(--text-sm)' }}>{(loadError as Error).message}</p>}
      {isLoading && <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>}

      <AnimatePresence mode="wait">
        {reveal ? (
          <motion.div key={`reveal-${reveal.card.key}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={cardStyle}>
            <span style={pill('var(--accent)')}>{SOURCE_LABEL[reveal.card.source]} · answered</span>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{reveal.card.title}</h2>
            {reveal.outcomes.map((o) => {
              const subject = reveal.card.subjects.find((s) => s.subjectId === o.subjectId);
              const agree = agreement(reveal.verdict, o.guard.verdict);
              return (
                <div key={o.subjectId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                    {subject?.kidName}: you said <strong>{verdictLabel(reveal.verdict)}</strong>
                    {agree === 'agree' && ' — the guard agreed.'}
                    {agree === 'disagree' && <span style={{ color: 'var(--dismiss)', fontWeight: 600 }}> — the guard said {verdictLabel(o.guard.verdict)}.</span>}
                    {' '}<span style={{ color: 'var(--text-tertiary)' }}>{effectLabel(o.effect)}.</span>
                  </p>
                  <GuardPanel guard={o.guard} title="Guard" />
                </div>
              );
            })}
            <button onClick={next} style={actionButton('var(--accent)', true)}>Next <span style={{ opacity: 0.6, fontSize: 'var(--text-xs)' }}>Enter</span></button>
          </motion.div>
        ) : current ? (
          <motion.div key={current.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={pill(current.source === 'escalation' ? '#E07C3A' : 'var(--accent)')}>{SOURCE_LABEL[current.source]}</span>
              {current.subjects.map((s) => (
                <span key={s.subjectId} style={pill('#6B6860')}>{s.kidName} · {s.ageBand}</span>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{cards.length} left</span>
            </div>

            <VideoSummary card={current} />

            {current.source === 'escalation' && current.subjects.map((s) => s.guard && (
              <GuardPanel key={s.subjectId} guard={s.guard} title={multi ? `Guard for ${s.kidName}` : 'Guard'} />
            ))}

            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={busy} onClick={() => void decide('clear_yes')} style={actionButton('var(--save)', true)}>
                <Check size={18} /> {multi ? 'Allow both' : 'Allow'} <span style={{ opacity: 0.6, fontSize: 'var(--text-xs)' }}>A</span>
              </button>
              <button disabled={busy} onClick={() => void decide('clear_no')} style={actionButton('var(--dismiss)', true)}>
                <X size={18} /> {multi ? 'Block both' : 'Block'} <span style={{ opacity: 0.6, fontSize: 'var(--text-xs)' }}>B</span>
              </button>
              <button disabled={busy} onClick={skip} style={{ ...actionButton('', false), flex: '0 0 auto' }} aria-label="Skip">
                <SkipForward size={18} /> <span style={{ opacity: 0.6, fontSize: 'var(--text-xs)' }}>S</span>
              </button>
            </div>

            {multi && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Or decide for one:</p>
                {current.subjects.map((s) => (
                  <div key={s.subjectId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>{s.kidName} ({s.ageBand})</span>
                    <button disabled={busy} onClick={() => void decide('clear_yes', s.userId)} style={{ ...actionButton('', false), flex: '0 0 auto', padding: '6px 12px', fontSize: 'var(--text-sm)' }}>Allow</button>
                    <button disabled={busy} onClick={() => void decide('clear_no', s.userId)} style={{ ...actionButton('', false), flex: '0 0 auto', padding: '6px 12px', fontSize: 'var(--text-sm)' }}>Block</button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        ) : !isLoading && data ? (
          <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px 0' }}>
            Nothing waiting{mode === 'today' ? ' today' : ''}.
            {mode === 'today' && counts && counts.escalations > 0 && ` ${counts.escalations} more escalations in Catch-up.`}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {flash && <p style={{ textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{flash}</p>}
    </Shell>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-card)',
  padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-2xl)', color: 'var(--text-primary)' }}>Decisions</h1>
        {children}
      </div>
    </div>
  );
}
