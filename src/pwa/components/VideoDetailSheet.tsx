import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Bookmark, BookmarkCheck } from 'lucide-react';
import type { CardData } from './Card';

const EASE: [number, number, number, number] = [0.33, 1, 0.68, 1];
const DUR = 0.3;

interface Props {
  card: CardData;
  onClose: () => void;
}

export function VideoDetailSheet({ card, onClose }: Props) {
  const thumbnail = card.youtubeId
    ? `https://i.ytimg.com/vi/${card.youtubeId}/hqdefault.jpg`
    : null;

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* Scrim */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: DUR, ease: 'easeOut' }}
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 49,
          background: 'rgba(0,0,0,0.55)',
        }}
      />

      {/* Sheet */}
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: DUR, ease: EASE }}
        role="dialog"
        aria-modal="true"
        aria-label={card.title}
        style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'var(--bg-primary)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Video surface — shared-element from card thumbnail */}
        <motion.div
          layoutId={card.youtubeId ? `thumb-${card.requestId}` : undefined}
          transition={{ duration: DUR, ease: EASE }}
          style={{
            width: '100%', aspectRatio: '16/9',
            background: '#000', flexShrink: 0, overflow: 'hidden',
            position: 'relative',
          }}
        >
          {card.nginxUrl ? (
            <video
              src={card.nginxUrl}
              controls
              autoPlay
              playsInline
              style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
            />
          ) : thumbnail ? (
            <img
              src={thumbnail} alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', background: 'var(--bg-elevated)' }} />
          )}

          {/* Close — overlaid on video */}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute', top: 12, right: 12, zIndex: 1,
              width: 34, height: 34, borderRadius: '50%',
              background: 'rgba(0,0,0,0.52)', backdropFilter: 'blur(6px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </motion.div>

        {/* Details body — in final position from mount, no entrance animation */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 20px 100px' }}>

          {/* Channel */}
          {card.channel && (
            <p style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.07em',
              textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 6,
            }}>
              {card.channel}
            </p>
          )}

          {/* Title */}
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 22, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em',
            color: 'var(--text-primary)', marginBottom: 20,
          }}>
            {card.title}
          </h1>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 28, marginBottom: 24, flexWrap: 'wrap' }}>
            <Stat label="Requested" value={timeAgo(card.requestedAt)} />
            {card.watchedAt && <Stat label="Watched" value={watchedAgo(card.watchedAt)} />}
            {card.savedAt && <Stat label="Saved" value={watchedAgo(card.savedAt)} />}
          </div>

          {/* Provenance */}
          {card.youtubeId && (
            <div style={{
              padding: '12px 14px', marginBottom: 24,
              background: 'var(--bg-surface)', borderRadius: 12,
              border: '1px solid var(--border-subtle)',
            }}>
              <p style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
                textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4,
              }}>
                Source
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
                YouTube
              </p>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <ActionButton
              label={card.savedAt ? 'Saved' : 'Save'}
              active={!!card.savedAt}
              icon={card.savedAt
                ? <BookmarkCheck size={15} strokeWidth={2.2} />
                : <Bookmark size={15} strokeWidth={2.2} />
              }
            />
          </div>
        </div>
      </motion.div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 3,
      }}>
        {label}
      </p>
      <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
        {value}
      </p>
    </div>
  );
}

function ActionButton({
  label, icon, active,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <button style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '10px 16px', borderRadius: 10,
      background: active ? 'var(--accent-subtle)' : 'var(--bg-surface)',
      color: active ? 'var(--accent)' : 'var(--text-secondary)',
      border: `1px solid ${active ? 'transparent' : 'var(--border-subtle)'}`,
      fontSize: 13, fontWeight: 600, cursor: 'pointer',
      fontFamily: 'inherit',
    }}>
      {icon}
      {label}
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
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
