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

// Dark colour shared between the card background and the gradient terminus —
// they must match exactly so the fade is seamless.
const CARD_BG = '#0a0a0a';

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
        // yt-dlp reports 0→100 per stream; hold max seen so bar never goes backwards
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

  const isLive        = ['ready', 'watched'].includes(data.status) && data.fileState === 'live' && !!data.nginxUrl;
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

  const metaLine = isRejected
    ? (data.rejectionReason ?? 'Not available')
    : isInProgress && !effectivelyLive
    ? (STATUS_LABEL[data.status] ?? data.status)
    : timeAgo(data.requestedAt);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: isSelected ? 0 : (isGone ? 0.65 : 1), y: 0 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
      whileTap={effectivelyLive ? { scale: 0.97 } : undefined}
      onClick={handleTap}
      style={{
        position: 'relative',
        borderRadius: 16,
        overflow: 'hidden',
        cursor: effectivelyLive ? 'pointer' : 'default',
        background: CARD_BG,
        boxShadow: 'var(--shadow-card)',
        border: '1px solid var(--border-subtle)',
      }}
    >

      {/* ── Image section ── */}
      <div style={{ position: 'relative', aspectRatio: '16/9' }}>

        {/* Background image */}
        <motion.div
          layoutId={`thumb-${data.requestId}`}
          transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
          style={{ position: 'absolute', inset: 0 }}
        >
          {data.thumbnailUrl && (
            <img
              src={data.thumbnailUrl} alt=""
              style={{
                width: '100%', height: '100%', objectFit: 'cover',
                filter: (isRecycled || (isDownloading && !downloadDone))
                  ? 'grayscale(1) opacity(0.3)'
                  : isGone ? 'grayscale(1) opacity(0.12)'
                  : 'none',
                transition: 'filter 0.6s ease',
              }}
              loading="lazy"
            />
          )}
        </motion.div>

        {/* Gradient — fades image into CARD_BG at the bottom */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: `linear-gradient(to top, ${CARD_BG} 0%, rgba(10,10,10,0.55) 38%, rgba(10,10,10,0) 68%)`,
        }} />

        {/* Type badge — top right */}
        {!isDownloading && !isGone && (
          <span style={{
            position: 'absolute', top: 11, right: 11,
            fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.78)', background: 'rgba(0,0,0,0.35)',
            backdropFilter: 'blur(6px)', padding: '3px 7px', borderRadius: 5,
          }}>
            Video
          </span>
        )}

        {/* Guard phase spinner */}
        <AnimatePresence>
          {isDownloading && !downloadDone && pct === null && (
            <motion.div
              key="guard-spinner"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              style={{
                position: 'absolute', inset: 0, zIndex: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(3px)',
              }}
            >
              <EddySpinner size={48} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Download progress badge */}
        {isDownloading && !downloadDone && pct !== null && (
          <span style={{
            position: 'absolute', top: 11, left: 11, zIndex: 3,
            fontSize: 9, fontWeight: 700, color: '#fff',
            background: 'rgba(0,0,0,0.55)', padding: '3px 7px', borderRadius: 5,
          }}>
            {pct}%
          </span>
        )}

        {/* Watched checkmark */}
        {isWatched && !isDownloading && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              background: 'rgba(61,107,107,0.75)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <polyline points="3.5,8 6.5,11.5 12.5,4.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
        )}

        {/* Channel + title — over the gradient, bottom of image */}
        {!isGone && (
          <div style={{
            position: 'absolute', bottom: 14, left: 14, right: 14, zIndex: 2,
          }}>
            {data.channel && (
              <div style={{
                display: 'inline-block', marginBottom: 4, marginLeft: -5,
                fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--accent)',
                background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
                padding: '3px 5px', borderRadius: 6,
                maxWidth: 'calc(100% + 5px)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
              }}>
                {data.channel}
              </div>
            )}
            <h2 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 20, fontWeight: 600, lineHeight: 1.25,
              letterSpacing: '-0.015em', margin: 0,
              color: isRecycled ? 'rgba(255,255,255,0.5)' : '#fff',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {isInProgress && !effectivelyLive && !data.title
                ? (STATUS_LABEL[data.status] ?? 'Getting it…')
                : data.title}
            </h2>
          </div>
        )}

        {/* Gone overlay — image area only */}
        {isGone && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 2,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'rgba(8,8,8,0.5)',
            color: 'rgba(255,255,255,0.7)',
          }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="10" cy="10" r="7.5"/><path d="M4 4l12 12"/>
            </svg>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              No longer available
            </span>
          </div>
        )}
      </div>

      {/* ── Metadata strip + recycled controls ── */}
      <div style={{ padding: '11px 14px 20px', position: 'relative' }}>

        {isRecycled ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
              color: 'rgba(255,255,255,0.45)',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M2 5a3 3 0 016 0M5 8V5"/><circle cx="5" cy="8.5" r="0.7" fill="currentColor"/>
              </svg>
              Recycled
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); }}
              style={{
                fontSize: 10, fontWeight: 600, color: '#fff', background: 'var(--accent)',
                border: 'none', padding: '5px 11px', borderRadius: 12,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 5.5a4 4 0 118 0M9.5 3v2.5H7"/>
              </svg>
              Restore
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 400,
              color: isRejected ? 'rgba(255,100,100,0.7)' : 'rgba(255,255,255,0.35)',
            }}>
              {metaLine}
            </span>
            {data.durationSecs != null && !isDownloading && !isInProgress && (
              <>
                <span style={{ color: 'rgba(255,255,255,0.18)', fontSize: 10 }}>·</span>
                <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.35)' }}>
                  {formatDuration(data.durationSecs)}
                </span>
              </>
            )}
            {isWatched && data.watchedAt && (
              <>
                <span style={{ color: 'rgba(255,255,255,0.18)', fontSize: 10 }}>·</span>
                <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(61,107,107,0.85)' }}>
                  {watchedAgo(data.watchedAt)}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Progress bars — absolute to article, pinned to very bottom ── */}
      {showProgressBar && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, zIndex: 4, background: 'rgba(255,255,255,0.08)' }}>
          <div style={{ height: '100%', width: `${progressFraction * 100}%`, background: 'var(--accent)', transition: 'width 0.5s ease' }} />
        </div>
      )}
      {isDownloading && !downloadDone && pct !== null && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, zIndex: 4, background: 'rgba(255,255,255,0.08)' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 0.8s ease' }} />
        </div>
      )}
      {isWatched && !isDownloading && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, zIndex: 4, background: 'rgba(255,255,255,0.08)' }}>
          <div style={{ height: '100%', width: '100%', background: 'var(--accent)' }} />
        </div>
      )}

    </motion.article>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function watchedAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return 'watched just now';
  if (hrs < 24) return `watched ${hrs}h ago`;
  return `watched ${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
