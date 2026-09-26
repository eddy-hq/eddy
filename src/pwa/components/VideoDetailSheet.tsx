import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useDragControls } from 'framer-motion';
import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { X, Bookmark, BookmarkCheck, Trash2, Share, Send, Download as DownloadIcon } from 'lucide-react';
import { readProgress, writeProgress, clearProgress } from '../lib/videoProgress';
import { useWatchEventTracker, type WatchSource } from '../lib/watchEvents';
import { canShare, shareVideo } from '../lib/webShare';
import { useResolvePersonId } from '../hooks/useResolvePersonId';
import { thumbnailSrc } from '../lib/thumbnailSrc';
import { SOURCE_DOT, sentFromLabel, sentWhyLine } from '../lib/provenance';
import {
  actionGridColumns,
  armedDeleteSpan,
  canSendTo,
  pickerOptions,
  sendResultMessage,
  type SendResult,
  type SendTarget,
} from '../lib/sendTo';
import { PersonRow } from './PersonRow';
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
  // Canonical YouTube watch URL stored on the request. Distinct from
  // `videoUrl` (local nginx stream) — used by the Share tile.
  youtubeWatchUrl: string | null;
  // Eddy's own thumbnail (public URL) or null; never a YouTube-hosted image.
  thumbnailUrl: string | null;
  whyText: string | null;
  source: string;
  requestedAt: string;
  watchedAt: string | null;
  savedAt: string | null;
  // The sending parent's display name on a parent pick (#217), else null.
  sentByName?: string | null;
}

async function fetchRequest(id: string): Promise<RequestDetail> {
  const res = await fetch(`/requests/${id}`);
  if (!res.ok) throw new Error('Not found');
  return res.json() as Promise<RequestDetail>;
}

// Kids this user can send a video to (#217). Empty for a kid, which is what
// keeps the Send-to tile parent-only.
async function fetchSendTargets(userId: string): Promise<SendTarget[]> {
  const res = await fetch(`/requests/send-targets?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) return [];
  const body = await res.json() as { kids?: SendTarget[] };
  return body.kids ?? [];
}

async function postSend(requestId: string, userId: string, kidIds: string[]): Promise<SendResult[]> {
  const res = await fetch(`/requests/${requestId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, kidIds }),
  });
  const body = await res.json().catch(() => ({})) as { results?: SendResult[]; message?: string };
  if (!res.ok) throw new Error(body.message ?? 'Could not send');
  return body.results ?? [];
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
      youtubeWatchUrl={card.youtubeWatchUrl}
      thumbnailUrl={card.thumbnailUrl}
      progress={null}
      rejectionReason={card.rejectionReason}
      whyText={card.whyText}
      requestSource={card.source}
      requestedAt={card.requestedAt}
      watchedAt={card.watchedAt}
      savedAt={card.savedAt}
      sentByName={card.sentByName ?? null}
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
      youtubeWatchUrl={data?.youtubeWatchUrl ?? null}
      thumbnailUrl={data?.thumbnailUrl ?? null}
      progress={data?.progress ?? null}
      rejectionReason={data?.rejectionReason ?? null}
      whyText={data?.whyText ?? null}
      requestSource={data?.source ?? null}
      requestedAt={data?.requestedAt ?? null}
      watchedAt={data?.watchedAt ?? null}
      savedAt={data?.savedAt ?? null}
      sentByName={data?.sentByName ?? null}
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
  // Canonical YouTube watch URL — drives the Share tile. Null/empty when
  // the row hasn't loaded yet in id-mode, in which case the tile is hidden
  // for that render.
  youtubeWatchUrl: string | null;
  thumbnailUrl: string | null;
  progress: number | null;
  rejectionReason: string | null;
  whyText: string | null;
  // The DB `requests.source` value ('share_sheet' | 'channel_subscription' |
  // 'recommended'). Drives the "Why this video" pill and templated line.
  // Distinct from `source: WatchSource` (telemetry) below.
  requestSource: string | null;
  requestedAt: string | null;
  watchedAt: string | null;
  savedAt: string | null;
  sentByName: string | null;
  source: WatchSource;
  onClose: () => void;
  enableLayoutId: boolean;
}

function SheetBody({
  requestId, userId,
  title, channel, youtubeId, youtubeChannelId,
  status, videoUrl, youtubeWatchUrl, thumbnailUrl,
  progress, rejectionReason,
  whyText, requestSource,
  requestedAt, watchedAt, savedAt, sentByName,
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

  // Send to (#217): parent-only, on a playable video. The send-targets read
  // returns kids only for a parent, so a kid never sees the tile.
  const { data: sendTargets } = useQuery({
    queryKey: ['send-targets', userId],
    queryFn: () => fetchSendTargets(userId),
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });
  const showSend = canSendTo(sendTargets, isReady);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const sendMutation = useMutation({
    mutationFn: (kidIds: string[]) => postSend(requestId, userId, kidIds),
    onSuccess: (results) => {
      setSendMessage(sendResultMessage(results));
    },
  });

  function openSend() {
    setConfirmDelete(false);
    setDeleteError(false);
    setSendMessage(null);
    sendMutation.reset();
    setSendOpen(true);
  }

  function closeSend() {
    setSendOpen(false);
    setSendMessage(null);
    sendMutation.reset();
  }

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

  // Manual download for a failed row (mirrors Card's tap-to-download). Only
  // reachable in id-mode — card-mode sheets open on playable rows only. On
  // success, invalidating the request query flips the sheet to 'downloading'
  // and its 3s poll carries it through progress → ready → playback.
  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/requests/${requestId}/retry`, { method: 'POST' });
      if (!res.ok) throw new Error('Retry failed');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['request', requestId] });
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

  const thumbnail = thumbnailSrc(thumbnailUrl);

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
              onRetry={() => retryMutation.mutate()}
              retryPending={retryMutation.isPending}
              retryErrored={retryMutation.isError}
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
          {/* Person row — shown for any resolvable channel (name + channelId).
              Renders nothing when that metadata is missing (#138); a channel
              with no Person row yet still shows "Not followed" and resolves the
              Person on tap. */}
          {canTapToPerson && channel && youtubeChannelId && (
            <PersonRow
              userId={userId}
              channel={channel}
              channelId={youtubeChannelId}
              onTap={() => void goToPerson()}
            />
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

          {showActions && (
            <ActionGrid
              isSaved={isSaved}
              saving={saving}
              onToggleSave={() => void toggleSave()}
              confirmDelete={confirmDelete}
              deletePending={deleteMutation.isPending}
              deleteError={deleteError}
              onArmDelete={() => { closeSend(); setConfirmDelete(true); }}
              onConfirmDelete={() => { setDeleteError(false); deleteMutation.mutate(); }}
              onCancelDelete={() => { setConfirmDelete(false); setDeleteError(false); }}
              youtubeWatchUrl={youtubeWatchUrl}
              shareTitle={title}
              showSend={showSend}
              sendOpen={sendOpen}
              onOpenSend={openSend}
            />
          )}

          {showActions && showSend && sendOpen && sendTargets && (
            <SendPicker
              kids={sendTargets}
              pending={sendMutation.isPending}
              error={sendMutation.isError ? sendMutation.error.message : null}
              message={sendMessage}
              onSend={(kidIds) => sendMutation.mutate(kidIds)}
              onClose={closeSend}
            />
          )}

          <WhyThisVideo
            requestSource={requestSource}
            whyText={whyText}
            channel={channel}
            sentByName={sentByName}
          />
        </div>
      </motion.div>
    </>
  );
}

// ── Non-ready overlay (rendered inside the 16:9 player area) ─────────────────

function UnreadyOverlay({
  status, progress, rejectionReason, thumbnail,
  onRetry, retryPending, retryErrored,
}: {
  status: string;
  progress: number | null;
  rejectionReason: string | null;
  thumbnail: string | null;
  onRetry: () => void;
  retryPending: boolean;
  retryErrored: boolean;
}) {
  const isRejected = status === 'rejected';
  const isDeleted = status === 'deleted';
  const isDownloading = status === 'downloading';
  const isFailed = status === 'failed';

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
      {isFailed && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retryPending}
          style={{
            position: 'relative',
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 18px', minHeight: 44,
            borderRadius: 22, border: '1.5px solid rgba(255,255,255,0.4)',
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            color: '#F4F1EA', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: retryPending ? 'default' : 'pointer',
            opacity: retryPending ? 0.6 : 1,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <DownloadIcon size={16} strokeWidth={2.4} />
          {retryPending ? 'Starting…' : retryErrored ? 'Try again' : 'Download'}
        </button>
      )}
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
    failed: 'Not downloaded',
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

// ── ActionGrid — 3-up tile grid (Save / Delete / Share) ─────────────────────
//
// Replaces the old inline-pill action row. Shape and tokens lifted from the
// design prototype `.vp-actions` block; tokens mapped to existing names where
// possible (`--bg-surface`, `--border-subtle`, `--text-secondary`,
// `--save`, `--dismiss`) with `--teal` added for the Share affordance.
//
// Behaviour preserved verbatim:
//   - Save: optimistic toggle, `saving` lock, `.on` styling when saved.
//   - Delete: two-step confirm in-place so the layout doesn't jump — the
//     Delete tile is replaced by Yes-delete + Cancel tiles in its grid slot
//     while armed, with a "Delete?" caption above the row (matching the
//     original `Delete? · Yes, delete · Cancel` copy from the inline row).
//   - Share: hidden when `navigator.share` is unavailable OR when no
//     `youtubeWatchUrl` is on hand (defends against the rare null case).

function ActionGrid({
  isSaved, saving, onToggleSave,
  confirmDelete, deletePending, deleteError,
  onArmDelete, onConfirmDelete, onCancelDelete,
  youtubeWatchUrl, shareTitle,
  showSend, sendOpen, onOpenSend,
}: {
  isSaved: boolean;
  saving: boolean;
  onToggleSave: () => void;
  confirmDelete: boolean;
  deletePending: boolean;
  deleteError: boolean;
  onArmDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  youtubeWatchUrl: string | null;
  shareTitle: string | null;
  // Send to (#217) — parent-only; makes the grid 2×2.
  showSend: boolean;
  sendOpen: boolean;
  onOpenSend: () => void;
}) {
  const columns = actionGridColumns(showSend);
  // Bind to live navigator each render — supported flips can happen across
  // installed-PWA mode changes. Cheap call.
  const shareFn =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      ? navigator.share.bind(navigator)
      : null;
  const shareSupported = canShare({ share: shareFn }) && !!youtubeWatchUrl;

  async function handleShare() {
    if (!youtubeWatchUrl) return;
    await shareVideo(
      { url: youtubeWatchUrl, title: shareTitle },
      { share: shareFn },
    );
  }

  return (
    // The grid spec is `padding: 4px 16px 16px` measured from the sheet
    // edge. Our scrolling container already has 20px horizontal padding, so
    // the row escapes it with -20px side margins and re-applies the 16px
    // itself — net effect matches the prototype regardless of the
    // surrounding container's padding.
    <div style={{ margin: '0 -20px 8px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: columns === 2 ? '1fr 1fr' : '1fr 1fr 1fr',
          gap: 8,
          padding: confirmDelete ? '4px 16px 4px' : '4px 16px 16px',
        }}
      >
        {/* Save tile — dimmed in confirm mode so the row reads as
            single-purpose: only Delete and Cancel are in play. */}
        <Tile
          label={isSaved ? 'Saved' : 'Save'}
          icon={isSaved
            ? <BookmarkCheck size={20} strokeWidth={1.8} />
            : <Bookmark size={20} strokeWidth={1.8} />}
          active={isSaved}
          activeColor="var(--save)"
          activeBg="rgba(58, 125, 90, 0.08)"
          disabled={saving || confirmDelete}
          dimmed={confirmDelete}
          onClick={onToggleSave}
        />

        {/* Delete slot — armed state is a filled-red destructive tile that
            spans the Save-adjacent cells (middle + right) so it carries the
            full visual weight an iOS destructive confirm expects. Cancel is
            a plain-text link below the grid, not a competing tile. */}
        {confirmDelete ? (
          <Tile
            label={deletePending ? 'Deleting…' : deleteError ? 'Try again' : 'Delete'}
            icon={<Trash2 size={20} strokeWidth={1.8} />}
            filled
            activeColor="var(--dismiss)"
            disabled={deletePending}
            onClick={onConfirmDelete}
            ariaLabel={
              deletePending ? 'Deleting'
              : deleteError ? 'Delete failed — try again'
              : 'Confirm delete'
            }
            style={{ gridColumn: `span ${armedDeleteSpan(columns)}` }}
          />
        ) : (
          <Tile
            label="Delete"
            icon={<Trash2 size={20} strokeWidth={1.8} />}
            hoverColor="var(--dismiss)"
            // Match the prototype's `.dismiss.on` tinted background on press
            // too (touch devices don't fire hover before tap-release).
            activeBg="rgba(184, 84, 80, 0.08)"
            onClick={onArmDelete}
          />
        )}

        {/* Share tile — hidden entirely when Web Share is unavailable so we
            don't render a dead control (issue #137 acceptance criterion). The
            grid's `1fr 1fr 1fr` template leaves a blank cell in that case;
            acceptable for the no-share fallback and avoids re-flowing Save
            and Delete into wider tiles. Also hidden while Delete is armed —
            the filled confirm tile spans into its slot. */}
        {shareSupported && !confirmDelete && (
          <Tile
            label="Share"
            icon={<Share size={20} strokeWidth={1.8} />}
            hoverColor="var(--teal)"
            onClick={() => { void handleShare(); }}
          />
        )}

        {/* Send to (#217) — parent-only. Opens the inline picker below the
            grid; hidden while Delete is armed, like Share. */}
        {showSend && !confirmDelete && (
          <Tile
            label="Send to"
            icon={<Send size={20} strokeWidth={1.8} />}
            active={sendOpen}
            activeColor={SOURCE_DOT.sent}
            activeBg="rgba(91, 111, 168, 0.08)"
            onClick={onOpenSend}
          />
        )}
      </div>

      {/* Cancel — plain-text link, iOS HIG: never equal-weight to the
          destructive action. Quiet, centred, 44px hit area. */}
      {confirmDelete && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 16px 12px' }}>
          <button
            type="button"
            onClick={onCancelDelete}
            disabled={deletePending}
            style={{
              background: 'none',
              border: 'none',
              padding: '11px 24px',
              minHeight: 44,
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              cursor: deletePending ? 'default' : 'pointer',
              opacity: deletePending ? 0.5 : 1,
              WebkitTapHighlightColor: 'transparent',
              outline: 'none',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── SendPicker — inline kid picker for Send to (#217) ───────────────────────
//
// Follows the Delete confirm's inline pattern: a caption, a row of option
// tiles (each kid, then Both), and a quiet Cancel link. After a send the row
// shows the outcome ("Sent" / "Already in their feed") and a Done link.

function SendPicker({
  kids, pending, error, message, onSend, onClose,
}: {
  kids: SendTarget[];
  pending: boolean;
  error: string | null;
  message: string | null;
  onSend: (kidIds: string[]) => void;
  onClose: () => void;
}) {
  const options = pickerOptions(kids);
  return (
    <div style={{ margin: '0 -20px 16px', padding: '0 16px' }}>
      <p style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-tertiary)',
        margin: '0 0 8px',
      }}>
        {pending ? 'Sending…' : 'Send to'}
      </p>

      {message ? (
        <p role="status" style={{
          margin: '0 0 4px', fontSize: 14, fontWeight: 600,
          color: SOURCE_DOT.sent,
        }}>
          {message}
        </p>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(options.length, 3)}, 1fr)`,
          gap: 8,
        }}>
          {options.map((o) => (
            <Tile
              key={o.key}
              label={o.label}
              icon={<Send size={16} strokeWidth={1.8} />}
              hoverColor={SOURCE_DOT.sent}
              disabled={pending}
              onClick={() => onSend(o.kidIds)}
              ariaLabel={`Send to ${o.label}`}
            />
          ))}
        </div>
      )}

      {error && !message && (
        <p role="alert" style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--dismiss)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          style={{
            background: 'none',
            border: 'none',
            padding: '11px 24px',
            minHeight: 44,
            fontFamily: 'inherit',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-secondary)',
            cursor: pending ? 'default' : 'pointer',
            opacity: pending ? 0.5 : 1,
            WebkitTapHighlightColor: 'transparent',
            outline: 'none',
          }}
        >
          {message ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

// Generic action tile. `active` forces the on-state colour treatment;
// `hoverColor` overrides the hover/focus + press border + text colour
// without changing the resting state (used for Share and the un-armed
// Delete tile, which have no on-state). `filled` is the iOS destructive-
// confirm look — solid token-colour fill with white glyphs, used for the
// armed Delete state. `dimmed` fades the tile and disables interaction
// without the muted-but-tappable feel of `disabled` alone (used to push
// Save out of the visual hierarchy while Delete is armed). On touch devices
// `hovered` rarely fires before tap-release, so press is treated
// equivalently — both surface the token colour and the tinted background.
function Tile({
  label, icon, active = false, filled = false, dimmed = false,
  activeColor, activeBg, hoverColor,
  disabled = false, onClick, ariaLabel,
  style,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  filled?: boolean;
  dimmed?: boolean;
  activeColor?: string;
  activeBg?: string;
  hoverColor?: string;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
  style?: React.CSSProperties;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  // Filled mode overrides the bordered colour-on-press treatment entirely:
  // background = token, glyphs = white, no separate border colour. Used for
  // the armed Delete tile so it reads as a primary destructive action, not
  // just "the Delete tile but red-bordered".
  let effectiveBg: string;
  let effectiveBorder: string;
  let effectiveTextColor: string;

  if (filled && activeColor) {
    effectiveBg = activeColor;
    effectiveBorder = activeColor;
    effectiveTextColor = '#fff';
  } else {
    // Token treatment fires on three triggers: explicit `active`, hover, or
    // press. Press matters for touch — without it the Share tile never
    // turns teal on tap, and the resting Delete tile never flashes
    // dismiss-red.
    const interactive = hovered || pressed;
    const tokenColor = activeColor ?? hoverColor;
    const showActiveTreatment = active || (interactive && tokenColor);
    const effectiveColor = showActiveTreatment ? tokenColor : undefined;
    effectiveBorder = effectiveColor ?? 'var(--border-subtle)';
    effectiveTextColor = effectiveColor ?? 'var(--text-secondary)';
    // Background priority: `active` + `activeBg` (sticky on-state tint) →
    // press with a tint colour available (transient tint matching the
    // token) → press without a tint (neutral elevated) → resting surface.
    effectiveBg = active && activeBg
      ? activeBg
      : pressed && activeBg
        ? activeBg
        : pressed
          ? 'var(--bg-elevated)'
          : 'var(--bg-surface)';
  }

  const opacity = dimmed ? 0.4 : disabled ? 0.65 : 1;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => { setHovered(false); setPressed(false); }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      aria-label={ariaLabel ?? label}
      aria-pressed={active || undefined}
      style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 4,
        padding: '10px 6px',
        background: effectiveBg,
        border: `1px solid ${effectiveBorder}`,
        borderRadius: 12,
        fontFamily: 'inherit',
        fontSize: 11.5, fontWeight: 600, letterSpacing: '0.01em',
        color: effectiveTextColor,
        cursor: disabled ? 'default' : 'pointer',
        opacity,
        transition: 'background 120ms, border-color 120ms, color 120ms, opacity 120ms',
        WebkitTapHighlightColor: 'transparent',
        outline: 'none',
        minHeight: 64,
        ...style,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0 }}>
        {icon}
      </span>
      <span>{label}</span>
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

// ── "Why this video" — inline provenance + editorial line ──────────────────
//
// Brief §9a: every discovery-surfaced item carries a one-sentence Gemma
// rationale. Originally tap-to-see; reversed to inline text once the full
// video page existed to host it without crowding the feed. `whyText` is the
// Gemma sentence (only populated for `requestSource === 'recommended'`).
// For other sources a templated lead-in stands in so the block doesn't read
// as a discovery-only chrome.

type ProvenanceKind = 'req' | 'follow' | 'pick' | 'sent';

function provenanceKind(source: string | null): ProvenanceKind {
  if (source === 'share_sheet') return 'req';
  if (source === 'channel_subscription') return 'follow';
  if (source === 'parent_pick') return 'sent';
  return 'pick';
}

function provenanceLabel(kind: ProvenanceKind, channel: string | null, sentByName: string | null): string {
  if (kind === 'req') return 'You asked';
  if (kind === 'follow') return channel ?? 'A channel you follow';
  if (kind === 'sent') return sentFromLabel(sentByName);
  return 'Picked';
}

const PROV_COLOR: Record<ProvenanceKind, string> = {
  req: 'var(--source-req, #B8863C)',
  follow: 'var(--source-follow, var(--accent))',
  pick: 'var(--source-pick, #8C4A6A)',
  sent: SOURCE_DOT.sent,
};

function WhyThisVideo({
  requestSource, whyText, channel, sentByName,
}: {
  requestSource: string | null;
  whyText: string | null;
  channel: string | null;
  sentByName: string | null;
}) {
  const kind = provenanceKind(requestSource);
  const label = provenanceLabel(kind, channel, sentByName);

  const line = whyText
    ?? (kind === 'req' ? 'You asked for this.'
      : kind === 'follow' ? `New from ${channel ?? 'a channel you follow'}.`
      : kind === 'sent' ? sentWhyLine(sentByName)
      : null);

  if (!line) return null;

  return (
    <section style={{
      padding: '14px 14px 12px', marginBottom: 24,
      background: 'var(--bg-surface)', borderRadius: 12,
      border: '1px solid var(--border-subtle)',
    }}>
      <p style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-tertiary)',
        marginBottom: 8,
      }}>
        Why this video
      </p>
      <p style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: 600, letterSpacing: '0.02em',
        color: PROV_COLOR[kind], marginBottom: 8,
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: PROV_COLOR[kind],
        }} />
        {label}
      </p>
      <p style={{
        margin: 0,
        fontFamily: 'var(--font-serif)', fontStyle: 'italic',
        fontSize: 14.5, lineHeight: 1.4,
        color: 'var(--text-secondary)',
      }}>
        {line}
      </p>
    </section>
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
