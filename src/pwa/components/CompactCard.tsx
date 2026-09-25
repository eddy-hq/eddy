import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { RotateCw } from 'lucide-react';
import { readProgress, onProgressChange } from '../lib/videoProgress';
import { thumbnailSrc } from '../lib/thumbnailSrc';
import { useResolvePersonId } from '../hooks/useResolvePersonId';
import { useRestoreRequest } from '../hooks/useRestoreRequest';
import { useRestoreStore } from '../store/restore';
import { EddySpinner } from './EddySpinner';
import type { CardData } from './Card';

export type SourceKind = 'req' | 'follow' | 'pick';

// Timeline palette — keep in sync with index.css
const DOT: Record<SourceKind, string> = {
  req:    '#B8863C',           // amber-gold
  follow: 'var(--accent)',     // teal
  pick:   'var(--save)',       // save green
};

const SOURCE_LABEL: Record<SourceKind, string> = {
  req:    'You asked',
  follow: '',  // follow pills render channel name
  pick:   'Picked',
};

export function CompactCard({
  data,
  userId,
  sourceKind,
  onSelect,
}: {
  data: CardData;
  userId?: string;
  sourceKind: SourceKind | null;
  onSelect?: (data: CardData) => void;
}) {
  const navigate = useNavigate();
  const resolvePersonId = useResolvePersonId(userId ?? null);
  const canTapToPerson = !!data.youtubeChannelId && !!data.channel;

  async function goToPerson(e: React.MouseEvent | React.KeyboardEvent) {
    if (!data.channel || !data.youtubeChannelId) return;
    e.stopPropagation();
    const pid = await resolvePersonId(data.youtubeChannelId, data.channel);
    if (!pid) return;
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    navigate(`/person/${pid}${qs}`);
  }

  const isLive     = ['ready', 'watched'].includes(data.status) && data.fileState === 'live' && !!data.nginxUrl;
  const isRecycled = ['ready', 'watched'].includes(data.status) && data.fileState === 'recycled';
  const isGone     = data.fileState === 'gone';
  const isRejected = data.status === 'rejected';
  const isWatched  = !!data.watchedAt;

  // Restore flow — same global store as the full Card, so a tap on either
  // surface drives one shared in-flight state for this requestId.
  const { restore, entry: restoreEntry } = useRestoreRequest(data.requestId);
  const finishRestore = useRestoreStore((s) => s.finish);
  const isRestoring = !!restoreEntry && !restoreEntry.errored;
  const restoreError = restoreEntry?.errored ? (restoreEntry.errorMsg ?? null) : null;
  useEffect(() => {
    if (restoreEntry && !restoreEntry.errored && isLive) finishRestore(data.requestId);
  }, [restoreEntry, isLive, data.requestId, finishRestore]);

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

  const effectiveThumbnailUrl = thumbnailSrc(data.thumbnailUrl);

  function handleTap() {
    if (isRecycled) {
      if (!isRestoring) void restore();
      return;
    }
    if (isGone || isRejected) return;
    if (!isLive) return;
    if (onSelect) onSelect(data);
    else navigate(`/watch/${data.requestId}`);
  }

  const metaLabel = isRecycled
    ? (restoreError ?? (isRestoring ? 'Restoring…' : 'Tap to restore'))
    : isGone
    ? 'Find similar'
    : isRejected
    ? (data.rejectionReason ?? 'Not available')
    : isWatched
    ? 'Watched'
    : 'Not watched';

  const sourceLabel =
    sourceKind === 'follow'
      ? (data.channel ?? 'Follow')
      : sourceKind
      ? SOURCE_LABEL[sourceKind]
      : null;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isGone ? 0.72 : 1, y: 0 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.33, 1, 0.68, 1] }}
      whileTap={(isLive || (isRecycled && !isRestoring)) ? { scale: 0.985 } : undefined}
      onClick={handleTap}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '10px 12px 10px 10px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-card)',
        cursor: (isLive || (isRecycled && !isRestoring)) ? 'pointer' : 'default',
      }}
    >
      {/* Thumbnail */}
      <div style={{
        position: 'relative',
        width: 112,
        aspectRatio: '16/9',
        borderRadius: 8,
        overflow: 'hidden',
        flexShrink: 0,
        background: 'var(--bg-elevated)',
      }}>
        {effectiveThumbnailUrl && (
          <img
            src={effectiveThumbnailUrl}
            alt=""
            loading="lazy"
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              filter: isGone ? 'grayscale(1) brightness(0.55)'
                : isRecycled ? 'grayscale(1) opacity(0.5)'
                : 'none',
              transition: 'filter 0.4s ease',
            }}
          />
        )}

        {isRecycled && (
          <div
            aria-hidden
            style={{
              position: 'absolute', inset: 0, zIndex: 2,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
              color: '#F4F1EA',
            }}
          >
            {isRestoring ? (
              <EddySpinner size={26} />
            ) : (
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
                border: '1.2px solid rgba(255,255,255,0.4)',
              }}>
                <RotateCw size={14} strokeWidth={2.4} />
              </div>
            )}
          </div>
        )}
        {isGone && (
          <span style={badgeDark}>Gone</span>
        )}

        {data.durationSecs != null && !isGone && (
          <span style={{
            position: 'absolute', bottom: 4, right: 4,
            padding: '1px 5px',
            fontSize: 9, fontWeight: 600,
            background: 'rgba(0,0,0,0.68)',
            color: '#F4F1EA',
            borderRadius: 3,
            letterSpacing: '0.02em',
          }}>
            {formatDuration(data.durationSecs)}
          </span>
        )}

        {showProgressBar && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            height: 2, background: 'rgba(255,255,255,0.14)',
          }}>
            <div style={{
              height: '100%',
              width: `${progressFraction * 100}%`,
              background: 'var(--accent)',
            }} />
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
        <h3 style={{
          margin: '0 0 6px',
          fontFamily: 'var(--font-serif)',
          fontSize: 14, fontWeight: 500,
          lineHeight: 1.28, letterSpacing: '-0.005em',
          color: isGone ? 'var(--text-secondary)' : 'var(--text-primary)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {data.title}
        </h3>
        <div style={{
          display: 'flex', alignItems: 'center',
          gap: 6,
          fontSize: 10.5, fontWeight: 500,
          color: 'var(--text-secondary)',
        }}>
          {sourceKind && sourceLabel && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              color: DOT[sourceKind],
              fontWeight: 600, letterSpacing: '0.02em',
            }}>
              <span style={{
                width: 4, height: 4, borderRadius: '50%',
                background: DOT[sourceKind],
              }} />
              {sourceKind === 'follow' && canTapToPerson ? (
                <span
                  role="link"
                  tabIndex={0}
                  onClick={(e) => void goToPerson(e)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void goToPerson(e); } }}
                  style={{
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textDecorationColor: 'var(--border-subtle)',
                    textUnderlineOffset: 2,
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  {sourceLabel}
                </span>
              ) : sourceLabel}
            </span>
          )}
          {sourceKind && sourceLabel && (
            <span style={{ color: 'var(--text-tertiary)' }}>·</span>
          )}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: isWatched ? 'var(--text-tertiary)' : 'var(--text-secondary)',
          }}>
            {isWatched && <span style={{ color: 'var(--save)', fontWeight: 700 }}>✓</span>}
            {metaLabel}
          </span>
        </div>
      </div>
    </motion.article>
  );
}

const badgeLight: React.CSSProperties = {
  position: 'absolute', top: 5, left: 5,
  padding: '2px 6px',
  fontSize: 9, fontWeight: 600,
  background: 'rgba(244,241,234,0.94)',
  color: 'var(--text-primary)',
  borderRadius: 3,
  letterSpacing: '0.02em',
};
const badgeDark: React.CSSProperties = {
  ...badgeLight,
  background: 'rgba(26,25,22,0.84)',
  color: '#F4F1EA',
};

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
