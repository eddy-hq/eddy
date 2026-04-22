import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { readProgress, onProgressChange } from '../lib/videoProgress';
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

  const isLive     = ['ready', 'watched'].includes(data.status) && data.fileState === 'live' && !!data.nginxUrl;
  const isRecycled = ['ready', 'watched'].includes(data.status) && data.fileState === 'recycled';
  const isGone     = data.fileState === 'gone';
  const isRejected = data.status === 'rejected';
  const isWatched  = !!data.watchedAt;

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
    if (isRecycled) return; // TODO: restore flow — inherits from Card behaviour
    if (isGone || isRejected) return;
    if (!isLive) return;
    if (onSelect) onSelect(data);
    else navigate(`/watch/${data.requestId}`);
  }

  const metaLabel = isRecycled
    ? 'Tap to restore'
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
      whileTap={isLive ? { scale: 0.985 } : undefined}
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
        cursor: isLive ? 'pointer' : 'default',
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
                : isRecycled ? 'grayscale(0.65) brightness(0.88)'
                : 'none',
            }}
          />
        )}

        {isRecycled && (
          <span style={badgeLight}>Recycled</span>
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
              {sourceLabel}
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
