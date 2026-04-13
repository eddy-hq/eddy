import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bookmark, X, Play } from 'lucide-react';

export interface CardData {
  requestId: string;
  title: string;
  channel: string | null;
  youtubeId: string | null;
  status: string;
  nginxUrl: string | null;
  requestedAt: string;
  rejectionReason: string | null;
}

interface CardProps {
  data: CardData;
  onDismiss?: (id: string) => void;
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
  dismissed:     'Dismissed',
};

export function Card({ data, onDismiss }: CardProps) {
  const navigate = useNavigate();
  const isReady = data.status === 'ready' && !!data.nginxUrl;
  const isRejected = data.status === 'rejected';

  const thumbnail = data.youtubeId
    ? `https://i.ytimg.com/vi/${data.youtubeId}/hqdefault.jpg`
    : null;

  function handleTap() {
    if (isReady) navigate(`/watch/${data.requestId}`);
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25, ease: [0.33, 1, 0.68, 1] }}
      whileTap={isReady ? { scale: 0.97 } : undefined}
      onClick={handleTap}
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
        cursor: isReady ? 'pointer' : 'default',
        opacity: isRejected ? 0.6 : 1,
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* Thumbnail */}
      {thumbnail && (
        <div style={{ position: 'relative', aspectRatio: '16/9', background: 'var(--bg-elevated)' }}>
          <img
            src={thumbnail}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            loading="lazy"
          />
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
            {onDismiss && (
              <IconButton
                label="Dismiss"
                onClick={(e) => { e.stopPropagation(); onDismiss(data.requestId); }}
                icon={<X size={14} />}
              />
            )}
          </div>
          {/* Play overlay for ready videos */}
          {isReady && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff',
              }}>
                <Play size={20} fill="currentColor" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Body */}
      <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
        {/* Source line */}
        {data.channel && (
          <p style={{
            fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginBottom: 'var(--space-1)',
          }}>
            {data.channel}
          </p>
        )}

        {/* Title */}
        <h2 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 'var(--text-md)',
          fontWeight: 400,
          lineHeight: 1.35,
          color: 'var(--text-primary)',
          marginBottom: 'var(--space-2)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {data.title}
        </h2>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            fontSize: 'var(--text-xs)',
            color: isRejected ? 'var(--dismiss)' : isReady ? 'var(--accent)' : 'var(--text-tertiary)',
          }}>
            {STATUS_LABEL[data.status] ?? data.status}
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

function IconButton({ label, onClick, icon }: { label: string; onClick: (e: React.MouseEvent) => void; icon: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      style={{
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(0,0,0,0.55)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: 44, minWidth: 44, // tap target
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
