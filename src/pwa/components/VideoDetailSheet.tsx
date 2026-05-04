import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useDragControls, AnimatePresence } from 'framer-motion';
import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query';
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

// Either {card} (when opened from a list with full row data) or {requestId}
// (when opened from a notification deep link / direct URL with only an id).
type Props =
  & { source: WatchSource; onClose: () => void; userId?: string }
  & ({ card: CardData; requestId?: never } | { card?: never; requestId: string });

interface RequestDetail {
  requestId: string;
  userId: string | null;
  videoId: string | null;
  youtubeChannelId: string | null;
  status: string;
  progress: number | null;
  title: string | null;
  channel: string | null;
  rejectionReason: string | null;
  videoUrl: string | null;
  requestedAt: string;
  watchedAt: string | null;
  savedAt: string | null;
}

async function fetchRequest(id: string): Promise<RequestDetail> {
  const res = await fetch(`/requests/${id}`);
  if (!res.ok) throw new Error('Not found');
  return res.json() as Promise<RequestDetail>;
}

export function VideoDetailSheet(props: Props) {
  if ('card' in props && props.card) {
    return <SheetWithCard {...props} card={props.card} />;
  }
  return <SheetById {...props} requestId={props.requestId!} />;
}

// ── Card-mode (Feed/Person/Saved tap a row that already has full data) ──────

function SheetWithCard({
  card,
  userId: userIdProp,
  source,
  onClose,
}: { card: CardData; userId?: string; source: WatchSource; onClose: () => void }) {
  const userId = userIdProp ?? '';
  return (
    <SheetBody
      requestId={card.requestId}
      userId={userId}
      title={card.title}
      channel={card.channel}
      youtubeId={card.youtubeId}
      youtubeChannelId={card.youtubeChannelId}
      status={card.status}
      videoUrl={card.nginxUrl}
      progress={null}
      rejectionReason={card.rejectionReason}
      requestedAt={card.requestedAt}
      watchedAt={card.watchedAt}
      savedAt={card.savedAt}
      source={source}
      onClose={onClose}
      enableLayoutId
    />
  );
}

// ── Id-mode (notification deep link / direct URL — fetch the row first) ────

function SheetById({
  requestId,
  userId: userIdProp,
  source,
  onClose,
}: { requestId: string; userId?: string; source: WatchSource; onClose: () => void }) {
  const { data, isError } = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => fetchRequest(requestId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'ready' || status === 'watched' || status === 'rejected' || status === 'deleted'
        ? false
        : 3000;
    },
  });

  if (isError) {
    return <ErrorSheet message="Request not found." onClose={onClose} />;
  }

  // While we don't have a row yet, render the chrome with a loading state in
  // the player area. The drag/scrim still work so the user can dismiss.
  return (
    <SheetBody
      requestId={requestId}
      userId={userIdProp ?? data?.userId ?? ''}
      title={data?.title ?? null}
      channel={data?.channel ?? null}
      youtubeId={data?.videoId ?? null}
      youtubeChannelId={data?.youtubeChannelId ?? null}
      status={data?.status ?? 'pending'}
      videoUrl={data?.videoUrl ?? null}
      progress={data?.progress ?? null}
      rejectionReason={data?.rejectionReason ?? null}
      requestedAt={data?.requestedAt ?? null}
      watchedAt={data?.watchedAt ?? null}
      savedAt={data?.savedAt ?? null}
      source={source}
      onClose={onClose}
      enableLayoutId={false}
    />
  );
}

// ── Shared body ────────────────────────────────────────────────────────────

interface BodyProps {
  requestId: string;
  userId: string;
  title: string | null;
  channel: string | null;
  youtubeId: string | null;
  youtubeChannelId: string | null;
  status: string;
  videoUrl: string | null;
  progress: number | null;
  rejectionReason: string | null;
  requestedAt: string | null;
  watchedAt: string | null;
  savedAt: string | null;
  source: WatchSource;
  onClose: () => void;
  enableLayoutId: boolean;
}

function SheetBody({
  requestId, userId,
  title, channel, youtubeId, youtubeChannelId,
  status, videoUrl, progress, rejectionReason,
  requestedAt, watchedAt, savedAt,
  source, onClose, enableLayoutId,
}: BodyProps) {
  const dragControls = useDragControls();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSaveRef = useRef(0);
  const queryClient = useQueryClient();

  const resolvePersonId = useResolvePersonId(userId);
  const canTapToPerson = !!youtubeChannelId && !!channel;

  async function goToPerson() {
    if (!channel || !youtubeChannelId) return;
    const pid = await resolvePersonId(youtubeChannelId, channel);
    if (!pid) return;
    onClose();
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    navigate(`/person/${pid}${qs}`);
  }

  const [isSaved, setIsSaved] = useState(!!savedAt);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  // savedAt arrives async in id-mode; sync once it lands so the button shows the right state.
  useEffect(() => {
    setIsSaved(!!savedAt);
  }, [savedAt]);

  const isReady = (status === 'ready' || status === 'watched') && !!videoUrl;
  const isRejected = status === 'rejected';
  const isDeleted = status === 'deleted';
  // Hide actions until userId resolves in id-mode — Save/Delete still hit the
  // server fine, but the post-mutation invalidateQueries needs a real userId
  // or the local feed cache stays stale.
  const showActions = !isRejected && !isDeleted && !!userId;

  const watchEvent = useWatchEventTracker({
    videoRef,
    userId,
    requestId,
    videoId: youtubeId,
    source,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/requests/${requestId}/delete`, { method: 'POST' });
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
      const res = await fetch(`/requests/${requestId}/save`, {
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

  const thumbnail = youtubeId
    ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`
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
        writeProgress(userId, requestId, v.currentTime, v.duration);
      }
    };
  }, [userId, requestId]);

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
    const saved = readProgress(userId, requestId);
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
    writeProgress(userId, requestId, v.currentTime, v.duration);
  }

  function handlePause() {
    const v = videoRef.current;
    if (v && !v.ended && v.duration > 0) writeProgress(userId, requestId, v.currentTime, v.duration);
  }

  function handleEnded() {
    watchEvent.onEnded();
    clearProgress(userId, requestId);
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
        aria-label={title ?? 'Video'}
        style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'var(--bg-primary)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Video surface — full-area swipe zone + shared-element FLIP */}
        <motion.div
          layoutId={enableLayoutId && youtubeId ? `thumb-${requestId}` : undefined}
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
          {isReady && videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
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
          ) : (
            <UnreadyOverlay
              status={status}
              progress={progress}
              rejectionReason={rejectionReason}
              thumbnail={thumbnail}
            />
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
          {channel && (
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
                <span>{channel}</span>
                <ChevronRight size={13} strokeWidth={2.2} aria-hidden style={{ color: 'var(--text-tertiary)' }} />
              </button>
            ) : (
              <p style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '0.07em',
                textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 6,
              }}>
                {channel}
              </p>
            )
          )}

          {title && (
            <h1 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 22, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em',
              color: 'var(--text-primary)', marginBottom: 20,
            }}>
              {title}
            </h1>
          )}

          {(requestedAt || watchedAt || savedAt) && (
            <div style={{ display: 'flex', gap: 28, marginBottom: 24, flexWrap: 'wrap' }}>
              {requestedAt && <Stat label="Requested" value={timeAgo(requestedAt)} />}
              {watchedAt && <Stat label="Watched" value={relativeTime(watchedAt)} />}
              {savedAt && <Stat label="Saved" value={relativeTime(savedAt)} />}
            </div>
          )}

          {youtubeId && (
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

          {showActions && (
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
          )}
        </div>
      </motion.div>
    </>
  );
}

// ── Non-ready overlay (rendered inside the 16:9 player area) ─────────────────

function UnreadyOverlay({
  status, progress, rejectionReason, thumbnail,
}: {
  status: string;
  progress: number | null;
  rejectionReason: string | null;
  thumbnail: string | null;
}) {
  const isRejected = status === 'rejected';
  const isDeleted = status === 'deleted';
  const isDownloading = status === 'downloading';

  const message =
    isRejected ? (rejectionReason ?? "Eddy can't get this one.") :
    isDeleted ? 'This video has been deleted.' :
    statusLabel(status);

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 12, padding: 24,
      color: 'rgba(255,255,255,0.85)',
    }}>
      {thumbnail && !isRejected && !isDeleted && (
        <img
          src={thumbnail}
          alt=""
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'cover',
            filter: 'grayscale(1) opacity(0.25)',
          }}
        />
      )}
      <p style={{
        position: 'relative',
        fontSize: 13, fontWeight: 600, letterSpacing: '0.04em',
        textTransform: 'uppercase',
        textAlign: 'center', maxWidth: 280, margin: 0,
      }}>
        {message}
      </p>
      {isDownloading && progress !== null && (
        <div style={{
          position: 'relative',
          width: 160, height: 3, borderRadius: 2,
          background: 'rgba(255,255,255,0.18)', overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: 'var(--accent)', transition: 'width 0.5s ease',
          }} />
        </div>
      )}
    </div>
  );
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Waiting to start…',
    guard_review: 'Reviewing…',
    parent_review: 'Waiting for a grown-up…',
    approved: 'Approved, starting soon…',
    downloading: 'Downloading…',
  };
  return labels[status] ?? 'Working on it…';
}

// ── Error variant for the id-mode "request not found" case ──────────────────

function ErrorSheet({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: DUR, ease: 'easeOut' }}
        onClick={onClose}
        aria-hidden
        style={{ position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.55)' }}
      />
      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ duration: DUR, ease: EASE }}
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'var(--bg-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }}
      >
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{message}</p>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 10, right: 10,
            width: 32, height: 32, borderRadius: '50%',
            background: 'rgba(0,0,0,0.52)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', border: 'none', cursor: 'pointer',
          }}
        >
          <X size={15} strokeWidth={2.4} />
        </button>
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
