import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { readProgress, onProgressChange } from '../lib/videoProgress';
import { useFollowedByChannelName } from '../hooks/useFollowedByChannelName';
import { useResolvePersonId } from '../hooks/useResolvePersonId';
import { EddySpinner } from './EddySpinner';

export interface CardData {
  requestId: string;
  title: string;
  channel: string | null;
  youtubeId: string | null;
  youtubeChannelId: string | null;
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

// Fallback colour shown behind the thumbnail before the image loads.
const THUMB_BG = '#0a0a0a';

interface PollResult { pct: number | null; done: boolean; }

function useDownloadProgress(requestId: string, active: boolean): PollResult {
  const [result, setResult] = useState<PollResult>({ pct: null, done: false });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Sticks the last server-supplied number across transient nulls — the M4
  // endpoint returns progress=null if Redis is unavailable, which would
  // otherwise flick the bar back to the spinner mid-download.
  const lastPctRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setResult({ pct: null, done: false });
      lastPctRef.current = null;
      return;
    }

    async function poll() {
      try {
        const resp = await fetch(`/requests/${requestId}`);
        if (!resp.ok) return;
        const data = await resp.json() as { status?: string; progress?: number | null };
        const done = data.status === 'ready' || data.status === 'watched';
        // Worker owns monotonicity; we just hold the last non-null value.
        if (typeof data.progress === 'number') lastPctRef.current = data.progress;
        setResult({ pct: lastPctRef.current, done });
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
  sourceKind = null,
}: {
  data: CardData;
  userId?: string;
  onSelect?: (data: CardData) => void;
  isSelected?: boolean;
  sourceKind?: 'req' | 'follow' | 'pick' | null;
}) {
  const navigate = useNavigate();
  const followedByName = useFollowedByChannelName(userId ?? null);
  const resolvePersonId = useResolvePersonId(userId ?? null);
  const followedPersonId = data.channel ? followedByName.get(data.channel.toLowerCase()) ?? null : null;
  // Tap-through is enabled when we have any path to a personId: a sync hit on
  // the followed-by-name map, or a channelId we can resolve via /people/resolve
  // on click. Pre-migration cards (no channelId, not followed) stay non-tappable.
  const canTapToPerson = !!followedPersonId || !!data.youtubeChannelId;

  async function goToPerson(e: React.MouseEvent | React.KeyboardEvent) {
    if (!data.channel) return;
    e.stopPropagation();
    let pid = followedPersonId;
    if (!pid && data.youtubeChannelId) {
      pid = await resolvePersonId(data.youtubeChannelId, data.channel);
    }
    if (!pid) return;
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    navigate(`/person/${pid}${qs}`);
  }

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

  const effectiveThumbnailUrl = data.thumbnailUrl
    ?? (data.youtubeId ? `https://i.ytimg.com/vi/${data.youtubeId}/hqdefault.jpg` : null);

  function handleTap() {
    if (!effectivelyLive) return;
    if (onSelect) onSelect(data);
    else navigate(`/watch/${data.requestId}`);
  }

  const trailingMeta =
    isRejected ? (data.rejectionReason ?? 'Not available')
    : isInProgress && !effectivelyLive ? (STATUS_LABEL[data.status] ?? data.status)
    : isRecycled ? 'Recycled'
    : isWatched && data.watchedAt ? watchedAgo(data.watchedAt)
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
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 16,
        overflow: 'hidden',
        cursor: effectivelyLive ? 'pointer' : 'default',
        background: 'var(--bg-surface)',
        boxShadow: 'var(--shadow-card)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* Thumbnail */}
      <div style={{
        position: 'relative',
        aspectRatio: '16/9',
        overflow: 'hidden',
        background: THUMB_BG,
      }}>
        <motion.div
          layoutId={`thumb-${data.requestId}`}
          transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
          style={{ position: 'absolute', inset: 0 }}
        >
          {effectiveThumbnailUrl && (
            <img
              src={effectiveThumbnailUrl} alt=""
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

        {/* Duration badge — bottom right (top-right reserved for watched tick / future media-type badge) */}
        {!isDownloading && !isGone && data.durationSecs != null && (
          <span style={{
            position: 'absolute', bottom: 10, right: 10, zIndex: 2,
            fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
            color: '#F4F1EA', background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            padding: '4px 8px', borderRadius: 5,
          }}>
            {formatDuration(data.durationSecs)}
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
            position: 'absolute', top: 10, left: 10, zIndex: 3,
            fontSize: 9, fontWeight: 700, color: '#fff',
            background: 'rgba(0,0,0,0.55)', padding: '3px 7px', borderRadius: 5,
          }}>
            {pct}%
          </span>
        )}

        {/* Watched checkmark — top right corner */}
        {isWatched && !isDownloading && (
          <div style={{
            position: 'absolute', top: 10, right: 10, zIndex: 2, pointerEvents: 'none',
            width: 24, height: 24, borderRadius: '50%',
            background: 'rgba(61,107,107,0.85)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <polyline points="3.5,8 6.5,11.5 12.5,4.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}

        {/* Gone overlay */}
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

        {/* Progress bars — pinned to bottom of thumbnail */}
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
      </div>

      {/* Title + meta — below thumbnail */}
      <div style={{ padding: '12px 14px 14px' }}>
        <h2 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 19, fontWeight: 500, lineHeight: 1.22,
          letterSpacing: '-0.008em', margin: '0 0 6px',
          color: (isGone || isRecycled) ? 'var(--text-secondary)' : 'var(--text-primary)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {isInProgress && !effectivelyLive && !data.title
            ? (STATUS_LABEL[data.status] ?? 'Getting it…')
            : data.title}
        </h2>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          fontSize: 11, fontWeight: 500,
          color: isRejected ? 'var(--dismiss)' : 'var(--text-secondary)',
          letterSpacing: '0.005em',
        }}>
          {sourceKind && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
              color: sourceKind === 'req' ? '#B8863C'
                : sourceKind === 'pick' ? 'var(--save)'
                : 'var(--accent)',
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: sourceKind === 'req' ? '#B8863C'
                  : sourceKind === 'pick' ? 'var(--save)'
                  : 'var(--accent)',
              }} />
              {sourceKind === 'follow'
                ? <ChannelTap label={data.channel ?? 'Follow'} enabled={canTapToPerson} onTap={goToPerson} />
                : sourceKind === 'req' ? 'You asked'
                : 'Picked'}
            </span>
          )}
          {sourceKind && sourceKind !== 'follow' && data.channel && (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <ChannelTap label={data.channel} enabled={canTapToPerson} onTap={goToPerson} />
            </>
          )}
          {!sourceKind && data.channel && (
            <ChannelTap
              label={data.channel}
              enabled={canTapToPerson}
              onTap={goToPerson}
              style={{ fontWeight: 600, color: 'var(--text-primary)' }}
            />
          )}
          {((sourceKind || data.channel)) && (
            <span style={{ color: 'var(--text-tertiary)' }}>·</span>
          )}
          <span>{trailingMeta}</span>
        </div>
      </div>
    </motion.article>
  );
}

function ChannelTap({
  label, enabled, onTap, style,
}: {
  label: string;
  enabled: boolean;
  onTap: (e: React.MouseEvent | React.KeyboardEvent) => void;
  style?: React.CSSProperties;
}) {
  if (!enabled) return <span style={style}>{label}</span>;
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(e); } }}
      style={{
        ...style,
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationColor: 'var(--border-subtle)',
        textUnderlineOffset: 2,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </span>
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
