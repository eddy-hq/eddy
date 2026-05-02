import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useDragControls, AnimatePresence } from 'framer-motion';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { X, Bookmark, BookmarkCheck, ChevronRight, Trash2 } from 'lucide-react';
import { readProgress, writeProgress, clearProgress } from '../lib/videoProgress';
import { useWatchEventTracker, type WatchSource } from '../lib/watchEvents';
import { useResolvePersonId } from '../hooks/useResolvePersonId';
import type { CardData } from './Card';

const EASE: [number, number, number, number] = [0.33, 1, 0.68, 1];
const DUR = 0.3;
const DISMISS_OFFSET = 100;
const DISMISS_VELOCITY = 500;
const SWIPE_THRESHOLD_PX = 14;
const SAVE_INTERVAL_MS = 4000;

interface Props {
  card: CardData;
  userId: string;
  source: WatchSource;
  onClose: () => void;
}

export function VideoDetailSheet({ card, userId, source, onClose }: Props) {
  const dragControls = useDragControls();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSaveRef = useRef(0);
  const queryClient = useQueryClient();

  const resolvePersonId = useResolvePersonId(userId);
  const canTapToPerson = !!card.youtubeChannelId && !!card.channel;

  async function goToPerson() {
    if (!card.channel || !card.youtubeChannelId) return;
    const pid = await resolvePersonId(card.youtubeChannelId, card.channel);
    if (!pid) return;
    onClose();
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    navigate(`/person/${pid}${qs}`);
  }

  const [isSaved, setIsSaved] = useState(!!card.savedAt);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  const watchEvent = useWatchEventTracker({
    videoRef,
    userId,
    requestId: card.requestId,
    videoId: card.youtubeId,
    source,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/requests/${card.requestId}/delete`, { method: 'POST' });
      if (!res.ok) throw new Error('Delete failed');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feed', userId] });
      onClose();
    },
    onError: () => {
      setDeleteError(true);
    },
  });

  async function toggleSave() {
    if (saving) return;
    setSaving(true);
    const next = !isSaved;
    setIsSaved(next);
    try {
      const res = await fetch(`/requests/${card.requestId}/save`, {
        method: next ? 'POST' : 'DELETE',
      });
      if (!res.ok) throw new Error('save failed');
      void queryClient.invalidateQueries({ queryKey: ['feed', userId] });
    } catch {
      setIsSaved(!next);
    } finally {
      setSaving(false);
    }
  }

  // Gesture state shared across all swipe zones
  const gestureRef = useRef<{ startY: number; event: PointerEvent } | null>(null);

  const thumbnail = card.youtubeId
    ? `https://i.ytimg.com/vi/${card.youtubeId}/hqdefault.jpg`
    : null;

  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Save position on unmount if mid-play
  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (v && !v.ended && v.duration > 0) {
        writeProgress(userId, card.requestId, v.currentTime, v.duration);
      }
    };
  }, [userId, card.requestId]);

  // ── Gesture handlers ────────────────────────────────────────────────────────
  // All swipe zones use these three handlers. The scroll zone additionally
  // gates on scrollTop === 0 before calling gestureDown.

  function gestureDown(e: React.PointerEvent) {
    gestureRef.current = { startY: e.clientY, event: e.nativeEvent };
  }

  function gestureMove(e: React.PointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    if (e.clientY - g.startY > SWIPE_THRESHOLD_PX) {
      dragControls.start(g.event);
      gestureRef.current = null;
    }
  }

  function gestureEnd() {
    gestureRef.current = null;
  }

  function scrollDown(e: React.PointerEvent) {
    if ((scrollRef.current?.scrollTop ?? 0) === 0) gestureDown(e);
  }

  function handleDragEnd(_: unknown, info: { offset: { y: number }; velocity: { y: number } }) {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onClose();
  }

  // ── Video progress ───────────────────────────────────────────────────────────

  function handleLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    const saved = readProgress(userId, card.requestId);
    if (saved && saved.position > 2 && saved.position < saved.duration * 0.95) {
      v.currentTime = saved.position;
    }
  }

  function handleTimeUpdate() {
    watchEvent.onTimeUpdate();
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const now = Date.now();
    if (now - lastSaveRef.current < SAVE_INTERVAL_MS) return;
    lastSaveRef.current = now;
    writeProgress(userId, card.requestId, v.currentTime, v.duration);
  }

  function handlePause() {
    const v = videoRef.current;
    if (v && !v.ended && v.duration > 0) writeProgress(userId, card.requestId, v.currentTime, v.duration);
  }

  function handleEnded() {
    watchEvent.onEnded();
    clearProgress(userId, card.requestId);
  }

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
        style={{ position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.55)' }}
      />

      {/* Sheet */}
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: DUR, ease: EASE }}
        drag="y"
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.4 }}
        onDragEnd={handleDragEnd}
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
        {/* Video surface — full-area swipe zone + shared-element FLIP */}
        <motion.div
          layoutId={card.youtubeId ? `thumb-${card.requestId}` : undefined}
          transition={{ duration: DUR, ease: EASE }}
          onPointerDown={gestureDown}
          onPointerMove={gestureMove}
          onPointerUp={gestureEnd}
          style={{
            width: '100%', aspectRatio: '16/9',
            background: '#000', flexShrink: 0, overflow: 'hidden',
            position: 'relative',
            // Prevent browser from hijacking the downward touch as a scroll gesture
            touchAction: 'pan-x',
            cursor: 'grab',
          }}
        >
          {card.nginxUrl ? (
            <video
              ref={videoRef}
              src={card.nginxUrl}
              controls
              autoPlay
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={watchEvent.onPlay}
              onTimeUpdate={handleTimeUpdate}
              onPause={handlePause}
              onEnded={handleEnded}
              style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
            />
          ) : thumbnail ? (
            <img src={thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', background: 'var(--bg-elevated)' }} />
          )}

          {/* Close */}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute', top: 10, right: 10, zIndex: 1,
              width: 32, height: 32, borderRadius: '50%',
              background: 'rgba(0,0,0,0.52)', backdropFilter: 'blur(6px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            <X size={15} strokeWidth={2.4} />
          </button>
        </motion.div>

        {/* Details — swipe-to-dismiss only when scroll is at top */}
        <div
          ref={scrollRef}
          onPointerDown={scrollDown}
          onPointerMove={gestureMove}
          onPointerUp={gestureEnd}
          style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 100px' }}
        >
          {card.channel && (
            canTapToPerson ? (
              <button
                onClick={() => void goToPerson()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 0',
                  marginBottom: 4, marginLeft: -2,
                  background: 'none', border: 'none',
                  fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 600, letterSpacing: '0.07em',
                  textTransform: 'uppercase', color: 'var(--text-secondary)',
                  cursor: 'pointer', minHeight: 36,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <span>{card.channel}</span>
                <ChevronRight size={13} strokeWidth={2.2} aria-hidden style={{ color: 'var(--text-tertiary)' }} />
              </button>
            ) : (
              <p style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '0.07em',
                textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 6,
              }}>
                {card.channel}
              </p>
            )
          )}

          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 22, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em',
            color: 'var(--text-primary)', marginBottom: 20,
          }}>
            {card.title}
          </h1>

          <div style={{ display: 'flex', gap: 28, marginBottom: 24, flexWrap: 'wrap' }}>
            <Stat label="Requested" value={timeAgo(card.requestedAt)} />
            {card.watchedAt && <Stat label="Watched" value={relativeTime(card.watchedAt)} />}
            {card.savedAt && <Stat label="Saved" value={relativeTime(card.savedAt)} />}
          </div>

          {card.youtubeId && (
            <div style={{
              padding: '12px 14px', marginBottom: 24,
              background: 'var(--bg-surface)', borderRadius: 12,
              border: '1px solid var(--border-subtle)',
            }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                Source
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
                YouTube
              </p>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <SaveButton isSaved={isSaved} saving={saving} onToggle={() => void toggleSave()} />
            {confirmDelete ? (
              <>
                <span style={{ fontSize: 13, color: deleteError ? 'var(--destructive, #e53e3e)' : 'var(--text-secondary)', marginLeft: 4 }}>
                  {deleteError ? 'Failed — try again' : 'Delete?'}
                </span>
                <button
                  onClick={() => { setDeleteError(false); deleteMutation.mutate(); }}
                  disabled={deleteMutation.isPending}
                  style={{
                    fontSize: 13, fontWeight: 600,
                    color: 'var(--destructive, #e53e3e)',
                    minHeight: 44, padding: '0 8px',
                  }}
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button
                  onClick={() => { setConfirmDelete(false); setDeleteError(false); }}
                  style={{ fontSize: 13, color: 'var(--text-secondary)', minHeight: 44, padding: '0 8px' }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '11px 16px', borderRadius: 12,
                  background: 'var(--bg-surface)',
                  color: 'var(--text-secondary)',
                  border: '1.5px solid var(--border-subtle)',
                  fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'inherit',
                  WebkitTapHighlightColor: 'transparent',
                  outline: 'none',
                }}
              >
                <Trash2 size={16} strokeWidth={2.2} />
                Delete
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </>
  );
}

function SaveButton({
  isSaved, saving, onToggle,
}: {
  isSaved: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.button
      onClick={onToggle}
      disabled={saving}
      whileTap={{ scale: 0.91 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '11px 20px', borderRadius: 12,
        background: isSaved ? 'var(--accent-subtle)' : 'var(--bg-surface)',
        color: isSaved ? 'var(--accent)' : 'var(--text-secondary)',
        border: `1.5px solid ${isSaved ? 'var(--accent)' : 'var(--border-subtle)'}`,
        fontSize: 14, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
        fontFamily: 'inherit',
        transition: 'background 200ms ease, color 200ms ease, border-color 200ms ease',
        opacity: saving ? 0.65 : 1,
        WebkitTapHighlightColor: 'transparent',
        outline: 'none',
      }}
    >
      {/* Icon springs in when state flips */}
      <motion.span
        key={isSaved ? 'saved-icon' : 'unsaved-icon'}
        initial={{ scale: 0.5, rotate: isSaved ? -20 : 10 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 14 }}
        style={{ display: 'flex', alignItems: 'center', lineHeight: 0 }}
      >
        {isSaved
          ? <BookmarkCheck size={16} strokeWidth={2.2} />
          : <Bookmark size={16} strokeWidth={2.2} />}
      </motion.span>

      {/* Label cross-fades */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={isSaved ? 'saved-label' : 'save-label'}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          style={{ display: 'block' }}
        >
          {isSaved ? 'Saved' : 'Save'}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 3 }}>
        {label}
      </p>
      <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
        {value}
      </p>
    </div>
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

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
