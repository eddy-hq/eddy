import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { readProgress, onProgressChange } from '../lib/videoProgress';
import { EddySpinner } from './EddySpinner';

export interface CardData {
  requestId: string;
  title: string;
  channel: string | null;
  youtubeId: string | null;
  status: string;
  fileState: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
  durationSecs: number | null;
  requestedAt: string;
  rejectionReason: string | null;
  watchedAt: string | null;
  savedAt: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  downloading:   'Getting it…',
  guard_review:  'Reviewing…',
  parent_review: 'Waiting for approval',
  pending:       'Pending',
  approved:      'Approved',
  rejected:      'Not available',
};

interface PollResult { pct: number | null; done: boolean; }

function useDownloadProgress(requestId: string, active: boolean): PollResult {
  const [result, setResult] = useState<PollResult>({ pct: null, done: false });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxPctRef = useRef<number>(0);

  useEffect(() => {
    if (!active) {
      setResult({ pct: null, done: false });
      maxPctRef.current = 0;
      return;
    }

    async function poll() {
      try {
        const resp = await fetch(`/requests/${requestId}`);
        if (!resp.ok) return;
        const data = await resp.json() as { status?: string; progress?: number | null };
        const done = data.status === 'ready' || data.status === 'watched';
        const raw = typeof data.progress === 'number' ? data.progress : null;
        // yt-dlp reports 0→100 per stream (video then audio); hold the max seen value
        // through null gaps (inter-stream pause) so the bar never goes backwards
        const pct = raw !== null
          ? Math.max(raw, maxPctRef.current)
          : maxPctRef.current > 0 ? maxPctRef.current : null;
        if (pct !== null) maxPctRef.current = pct;
        setResult({ pct, done });
        if (done && timerRef.current) clearInterval(timerRef.current);
      } catch { /* best-effort */ }
    }

    void poll();
    timerRef.current = setInterval(() => void poll(), 2000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [requestId, active]);

  return result;
}

export function Card({
  data,
  userId,
  onSelect,
  isSelected = false,
}: {
  data: CardData;
  userId?: string;
  onSelect?: (data: CardData) => void;
  isSelected?: boolean;
}) {
  const navigate = useNavigate();

  const isLive        =['ready', 'watched'].includes(data.status) && data.fileState === 'live' && !!data.nginxUrl;
  const isRecycled    = ['ready', 'watched'].includes(data.status) && data.fileState === 'recycled';
  const isGone        = data.fileState === 'gone';
  const isRejected    = data.status === 'rejected';
  const isWatched     = !!data.watchedAt;
  const isDownloading = data.status === 'downloading';
  const isInProgress  = ['downloading', 'guard_review', 'parent_review', 'pending', 'approved'].includes(data.status);

  const { pct, done: downloadDone } = useDownloadProgress(data.requestId, isDownloading);
  const effectivelyLive = isLive || downloadDone;

  const [progressFraction, setProgressFraction] = useState<number>(() => {
    if (!userId) return 0;
    const p = readProgress(userId, data.requestId);
    return p && p.duration > 0 ? p.position / p.duration : 0;
  });

  useEffect(() => {
    if (!userId) return;
    return onProgressChange(userId, data.requestId, (p) => {
      setProgressFraction(p && p.duration > 0 ? p.position / p.duration : 0);
    });
  }, [userId, data.requestId]);

  const showProgressBar = isLive && !isWatched && progressFraction > 0.01 && progressFraction < 0.95;

  function handleTap() {
    if (!effectivelyLive) return;
    if (onSelect) onSelect(data);
    else navigate(`/watch/${data.requestId}`);
  }

  const cardOpacity = isGone ? 0.72 : 1;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: isSelected ? 0 : cardOpacity, y: 0 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
      whileTap={effectivelyLive ? { scale: 0.97 } : undefined}
      onClick={handleTap}
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 16,
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
        cursor: effectivelyLive ? 'pointer' : 'default',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* ── Thumbnail ── */}
      <motion.div
        layoutId={`thumb-${data.requestId}`}
        transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
        style={{ position: 'relative', aspectRatio: '16/9', background: 'var(--bg-elevated)', display: 'block', overflow: 'hidden' }}
      >
        {data.thumbnailUrl ? (
          <img
            src={data.thumbnailUrl} alt=""
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%', objectFit: 'cover',
              imageRendering: 'pixelated',
              filter: (isRecycled || (isDownloading && !downloadDone))
                ? 'grayscale(1) opacity(0.4)'
                : isGone ? 'grayscale(1) opacity(0.2)'
                : 'none',
              transition: 'filter 0.6s ease',
            }}
            loading="lazy"
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {data.durationSecs != null && !isDownloading && (
              <span style={{
                fontSize: 11, fontWeight: 600,
                color: 'rgba(255,255,255,0.6)',
                background: 'rgba(0,0,0,0.28)', padding: '4px 9px', borderRadius: 5,
              }}>
                {formatDuration(data.durationSecs)}
              </span>
            )}
          </div>
        )}

        {/* Content-type badge (top-left) */}
        {!isDownloading && (
          <span style={{
            position: 'absolute', top: 9, left: 9,
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.92)', background: 'rgba(0,0,0,0.48)',
            backdropFilter: 'blur(6px)', padding: '3px 7px', borderRadius: 5,
          }}>
            Video
          </span>
        )}

        {/* Guard phase — spinner while Gemma is scoring, before download begins */}
        <AnimatePresence>
          {isDownloading && !downloadDone && pct === null && (
            <motion.div
              key="guard-spinner"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              style={{
                position: 'absolute', inset: 0, zIndex: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.32)',
                backdropFilter: 'blur(3px)',
              }}
            >
              <EddySpinner size={52} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Download progress — shown once yt-dlp reports a percentage */}
        {isDownloading && !downloadDone && pct !== null && (
          <>
            <span style={{
              position: 'absolute', top: 9, left: 9, zIndex: 2,
              fontSize: 9, fontWeight: 700, color: '#fff',
              background: 'rgba(0,0,0,0.55)', padding: '3px 7px', borderRadius: 5,
            }}>
              {pct}%
            </span>
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.14)' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 0.8s ease' }} />
            </div>
          </>
        )}

        {/* Watched overlay */}
        {isWatched && !isDownloading && (
          <>
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(61,107,107,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <polyline points="4,9 7.5,13 14,5.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>
            <span style={{
              position: 'absolute', top: 8, left: 8,
              fontSize: 10, fontWeight: 600, color: '#fff',
              padding: '3px 8px', borderRadius: 20,
              background: 'rgba(61,107,107,0.88)', backdropFilter: 'blur(4px)',
            }}>
              {watchedAgo(data.watchedAt!)}
            </span>
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.14)' }}>
              <div style={{ height: '100%', width: '100%', background: 'var(--accent)' }} />
            </div>
          </>
        )}

        {/* Recycled overlay — gradient + restore CTA */}
        {isRecycled && (
          <>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.18) 60%, rgba(0,0,0,0.42) 100%)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', inset: 'auto 0 0 0', padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, zIndex: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.9)', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(6px)', padding: '4px 8px', borderRadius: 14 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M2 5a3 3 0 016 0M5 8V5"/><circle cx="5" cy="8.5" r="0.7" fill="currentColor"/>
                </svg>
                Recycled
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); }}
                style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: 'var(--accent)', border: 'none', padding: '6px 12px', borderRadius: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 5.5a4 4 0 118 0M9.5 3v2.5H7"/>
                </svg>
                Restore
              </button>
            </div>
          </>
        )}

        {/* Partial-watch progress bar */}
        {showProgressBar && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.14)', zIndex: 1 }}>
            <div style={{ height: '100%', width: `${progressFraction * 100}%`, background: 'var(--accent)', transition: 'width 0.5s ease' }} />
          </div>
        )}

        {/* Gone overlay */}
        {isGone && (
          <>
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.52)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, zIndex: 2, color: 'rgba(255,255,255,0.88)' }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="M5 5l12 12"/>
              </svg>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>No longer available</span>
            </div>
          </>
        )}
      </motion.div>

      {/* ── Body ── */}
      <div style={{ padding: '13px 14px 15px' }}>

        {/* Meta — channel */}
        {data.channel && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)' }}>{data.channel}</span>
          </div>
        )}

        {/* Title */}
        <h2 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 18, fontWeight: 600,
          lineHeight: 1.3, letterSpacing: '-0.01em', marginBottom: 8,
          color: (isWatched || isRecycled) ? 'var(--text-secondary)' : isGone ? 'var(--text-tertiary)' : 'var(--text-primary)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {isGone ? 'No longer available' : data.title}
        </h2>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{
            fontSize: 11, fontWeight: 500,
            color: isRejected ? 'var(--dismiss)' : 'var(--text-tertiary)',
          }}>
            {isInProgress && !effectivelyLive
              ? (STATUS_LABEL[data.status] ?? data.status)
              : isRejected
              ? (data.rejectionReason ?? 'Not available')
              : timeAgo(data.requestedAt)}
          </span>
        </div>
      </div>
    </motion.article>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'added just now';
  if (mins < 60) return `added ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `added ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `added ${days}d ago`;
}

function watchedAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return 'Watched just now';
  if (hrs < 24) return `Watched ${hrs}h ago`;
  return `Watched ${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
