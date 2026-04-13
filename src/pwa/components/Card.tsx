import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bookmark, X, Play, RotateCcw } from 'lucide-react';

export interface CardData {
  requestId: string;
  title: string;
  channel: string | null;
  youtubeId: string | null;
  status: string;
  fileState: string;           // live | recycled | gone
  nginxUrl: string | null;
  requestedAt: string;
  rejectionReason: string | null;
  watchedAt: string | null;
  savedAt: string | null;
}

interface CardProps {
  data: CardData;
  onDismiss?: (id: string) => void;
  onSave?: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  downloading:   'Getting it…',
  guard_review:  'Reviewing…',
  parent_review: 'Waiting for approval',
  pending:       'Pending',
  approved:      'Approved',
  ready:         'Ready',
  watched:       'Watched',
  rejected:      'Not available',
};

interface PollResult { pct: number | null; done: boolean; }

// Poll /requests/:id every 2s while downloading — returns progress and whether it's finished
function useDownloadProgress(requestId: string, active: boolean): PollResult {
  const [result, setResult] = useState<PollResult>({ pct: null, done: false });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) {
      setResult({ pct: null, done: false });
      return;
    }

    async function poll() {
      try {
        const resp = await fetch(`/requests/${requestId}`);
        if (!resp.ok) return;
        const data = await resp.json() as { status?: string; progress?: number | null };
        const done = data.status === 'ready' || data.status === 'watched';
        setResult({ pct: typeof data.progress === 'number' ? data.progress : null, done });
        if (done && timerRef.current) clearInterval(timerRef.current);
      } catch {
        // best-effort
      }
    }

    void poll();
    timerRef.current = setInterval(() => void poll(), 2000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [requestId, active]);

  return result;
}

export function Card({ data, onDismiss, onSave }: CardProps) {
  const navigate = useNavigate();
  const isLive     = ['ready', 'watched'].includes(data.status) && data.fileState === 'live' && !!data.nginxUrl;
  const isRecycled = ['ready', 'watched'].includes(data.status) && data.fileState === 'recycled';
  const isGone     = data.fileState === 'gone';
  const isRejected = data.status === 'rejected';
  const isWatched  = !!data.watchedAt;
  const isSaved    = !!data.savedAt;
  const isDownloading = data.status === 'downloading';
  const isInProgress  = ['downloading', 'guard_review', 'parent_review', 'pending', 'approved'].includes(data.status);

  const dimmed = isRecycled || isGone || isRejected;

  const { pct, done: downloadDone } = useDownloadProgress(data.requestId, isDownloading);

  // If our 2s poll detected ready before the feed 10s refresh, treat locally as live
  const effectivelyLive = isLive || downloadDone;

  const thumbnail = data.youtubeId
    ? `https://i.ytimg.com/vi/${data.youtubeId}/hqdefault.jpg`
    : null;

  function handleTap() {
    if (effectivelyLive) navigate(`/watch/${data.requestId}`);
  }

  // How much of the right side is still grey (0% = full colour, 100% = full grey)
  const greyRight = pct === null ? 100 : Math.max(0, 100 - pct);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ duration: 0.25, ease: [0.33, 1, 0.68, 1] }}
      whileTap={effectivelyLive ? { scale: 0.97 } : undefined}
      onClick={handleTap}
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
        cursor: effectivelyLive ? 'pointer' : 'default',
        opacity: dimmed ? 0.55 : 1,
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* Thumbnail */}
      {thumbnail && (
        <div style={{ position: 'relative', aspectRatio: '16/9', background: 'var(--bg-elevated)' }}>

          {/* Grey base — always shown */}
          <img
            src={thumbnail}
            alt=""
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%', objectFit: 'cover',
              filter: isDownloading && !downloadDone ? 'grayscale(100%)' : 'none',
              transition: 'filter 0.6s ease',
            }}
            loading="lazy"
          />

          {/* Colour reveal — clips in from the left as pct rises */}
          {isDownloading && !downloadDone && (
            <img
              src={thumbnail}
              alt=""
              aria-hidden
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%', objectFit: 'cover',
                clipPath: `inset(0 ${greyRight}% 0 0)`,
                transition: 'clip-path 0.8s ease',
              }}
            />
          )}

          {/* Progress bar */}
          {isDownloading && !downloadDone && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: 6, background: 'rgba(0,0,0,0.3)',
            }}>
              <div style={{
                height: '100%',
                width: `${pct ?? 0}%`,
                background: '#6366f1',
                transition: 'width 0.8s ease',
              }} />
            </div>
          )}

          {/* Progress percentage label */}
          {isDownloading && !downloadDone && (
            <div style={{
              position: 'absolute', bottom: 'var(--space-3)', left: 'var(--space-2)',
              background: 'rgba(0,0,0,0.6)', color: '#fff',
              fontSize: 'var(--text-xs)', fontWeight: 600,
              padding: '2px 8px', borderRadius: 'var(--radius-sm)',
            }}>
              {pct !== null ? `${pct}%` : 'Starting…'}
            </div>
          )}

          {/* Content type badge */}
          <div style={{
            position: 'absolute', top: 'var(--space-2)', left: 'var(--space-2)',
            background: 'rgba(0,0,0,0.55)', color: '#fff',
            fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.04em',
            padding: '2px 8px', borderRadius: 'var(--radius-sm)', textTransform: 'uppercase',
          }}>
            Video
          </div>

          {/* Action icons */}
          <div style={{
            position: 'absolute', top: 'var(--space-2)', right: 'var(--space-2)',
            display: 'flex', gap: 'var(--space-1)',
          }}>
            {onSave && !isRejected && (
              <IconButton
                label={isSaved ? 'Remove bookmark' : 'Bookmark'}
                onClick={(e) => { e.stopPropagation(); onSave(data.requestId); }}
                icon={<Bookmark size={14} fill={isSaved ? 'currentColor' : 'none'} />}
              />
            )}
            {onDismiss && (
              <IconButton
                label="Dismiss"
                onClick={(e) => { e.stopPropagation(); onDismiss(data.requestId); }}
                icon={<X size={14} />}
              />
            )}
          </div>

          {/* Play overlay */}
          {effectivelyLive && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              }}>
                <Play size={20} fill="currentColor" />
              </div>
            </div>
          )}

          {/* Recycled overlay */}
          {isRecycled && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.35)',
            }}>
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: '#fff',
              }}>
                <RotateCcw size={20} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>Tap to restore</span>
              </div>
            </div>
          )}

          {/* Watched tick */}
          {isWatched && (
            <div style={{
              position: 'absolute', bottom: 'var(--space-2)', left: 'var(--space-2)',
              background: 'rgba(0,0,0,0.55)', color: '#fff',
              fontSize: 'var(--text-xs)', padding: '2px 8px',
              borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              ✓ {watchedAgo(data.watchedAt!)}
            </div>
          )}
        </div>
      )}

      {/* Body */}
      <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
        {data.channel && (
          <p style={{
            fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginBottom: 'var(--space-1)',
          }}>
            {data.channel}
          </p>
        )}

        <h2 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 'var(--text-md)',
          fontWeight: 400,
          lineHeight: 1.35,
          color: isGone ? 'var(--text-tertiary)' : 'var(--text-primary)',
          marginBottom: 'var(--space-2)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {isGone ? 'No longer available' : data.title}
        </h2>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--text-xs)',
            color: isRejected ? 'var(--dismiss)'
              : effectivelyLive ? 'var(--accent)'
              : isInProgress ? 'var(--text-tertiary)'
              : 'var(--text-tertiary)',
          }}>
            {isGone ? 'No longer available' : (STATUS_LABEL[data.status] ?? data.status)}
          </span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            {timeAgo(data.requestedAt)}
          </span>
        </div>

        {isRejected && data.rejectionReason && (
          <p style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            {data.rejectionReason}
          </p>
        )}
      </div>
    </motion.article>
  );
}

function IconButton({ label, onClick, icon }: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(0,0,0,0.55)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: 44, minWidth: 44,
        margin: -8, padding: 8,
      }}
    >
      {icon}
    </button>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function watchedAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return 'Watched just now';
  if (hrs < 24) return `Watched ${hrs}h ago`;
  return `Watched ${Math.floor(hrs / 24)}d ago`;
}
