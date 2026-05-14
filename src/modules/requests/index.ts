import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError, NotFoundError } from '../../errors';
import { config } from '../../config';
import { downloadQueue, redis } from '../../queue';
import { getNotifications } from '../notifications';
import { resolveUserByIdOrName } from '../users';
// State machine lives in `./state` (pure dispatcher) with production wiring in
// `./state-default` (default ports + `getRequestsState` accessor). The router
// reaches `apply` via the accessor so the registered (or test-injected) state
// is read at call time, not captured at import.
import {
  findActiveDuplicateRequest,
  displayRejectionReason,
} from './state';
import { getRequestsState } from './state-default';

export {
  createRequestsState,
  CANCELLED_REASON,
  displayRejectionReason,
  findActiveDuplicateRequest,
} from './state';
export {
  registerDefaultRequestsState,
  getRequestsState,
} from './state-default';
export type {
  Status,
  TransitionResult,
  ApplyOutcome,
  Event,
  DownloadedFields,
  DeleteJobData,
  CreateFromShareSheetInput,
  CreateFromChannelPollInput,
  CreateFromCandidateInput,
  Ports,
  RequestsState,
} from './state';

export const requestsRouter = Router();

interface AdminRequestRow {
  request_id: string;
  url: string;
  youtube_id: string | null;
  title: string | null;
  status: string;
  rejection_reason: string | null;
  requested_at: string;
  user_name: string;
}

function pwaFeedUrl(userId: string): string {
  return `http://${config.TAILSCALE_IP}:${config.PORT}/feed?userId=${userId}`;
}

const YOUTUBE_REGEX = /^https?:\/\/((www\.|m\.)?youtube\.com\/(watch\?.*v=|shorts\/|live\/)|youtu\.be\/)[\w-]+/;

// Extract first http(s) URL from share-sheet text (iOS sends "Source: YouTube\nhttps://...")
function extractUrlFromText(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : text.trim();
}

// Follow redirects to resolve short/share URLs (share.google, youtu.be, etc.)
async function resolveUrl(raw: string): Promise<string> {
  const url = extractUrlFromText(raw);
  if (url.match(YOUTUBE_REGEX)) return url;
  try {
    // GET + follow HTTP redirects
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Eddy/1.0)' },
    });
    // If final URL after HTTP redirects is already YouTube, use it
    if (resp.url.match(YOUTUBE_REGEX)) return resp.url;
    // share.google JS-redirects — scan body for YouTube URLs
    const body = await resp.text();
    const m = body.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s"'\\]+|https?:\/\/youtu\.be\/[\w-]+/);
    if (m) return m[0].replace(/\\u0026/g, '&');
    return resp.url;
  } catch {
    return url;
  }
}

function extractYoutubeId(url: string): string | null {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /\/live\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export function readRecentRejectedRequestsForAdmin(): AdminRequestRow[] {
  return db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.title, r.status,
           r.rejection_reason, r.requested_at, u.display_name AS user_name
    FROM requests r
    JOIN users u ON r.user_id = u.user_id
    WHERE r.status = 'rejected'
      AND r.requested_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    ORDER BY r.requested_at DESC
    LIMIT 20
  `).all() as AdminRequestRow[];
}

// POST /requests — called by iOS Shortcut
requestsRouter.post('/', async (req: Request, res: Response) => {
  const { url, userId, user: userName } = req.body as { url?: string; userId?: string; user?: string };

  if (!url || typeof url !== 'string') {
    logger.warn({ bodyKeys: Object.keys(req.body ?? {}), contentType: req.headers['content-type'] }, 'POST /requests missing url');
    throw new ValidationError('url is required');
  }

  const resolvedUrl = await resolveUrl(url);
  if (!resolvedUrl.match(YOUTUBE_REGEX)) {
    logger.warn({ raw: url, resolved: resolvedUrl }, 'Rejected URL — not a YouTube URL');
    throw new ValidationError('url must be a YouTube URL');
  }

  // Accept either userId (UUID) or user (display name, case-insensitive) for Shortcut convenience
  const lookupValue = userId ?? userName;
  if (!lookupValue) {
    throw new ValidationError('userId or user is required');
  }
  const user = resolveUserByIdOrName(lookupValue);

  const youtubeId = extractYoutubeId(resolvedUrl);

  // Dedup: if this user already has a still-live request for the same video, return it
  if (youtubeId) {
    const existing = findActiveDuplicateRequest(user.user_id, youtubeId);

    if (existing) {
      logger.info({ requestId: existing.requestId, youtubeId }, 'Returning existing request');
      // Re-send the ready notification in case the user missed it
      if (existing.status === 'ready') {
        const row = db.prepare('SELECT title FROM requests WHERE request_id = ?')
          .get(existing.requestId) as { title: string | null } | undefined;
        void getNotifications().notify(
          {
            kind: 'video_ready',
            requestId: existing.requestId,
            title: row?.title ?? youtubeId ?? '',
          },
          user.user_id,
        );
      }
      return res.status(202).json({
        requestId: existing.requestId,
        status: existing.status,
        message: `Got it${user.role === 'kid' ? `, ${user.display_name}` : ''}. Working on it.`,
        pwaUrl: pwaFeedUrl(user.user_id),
      });
    }
  }

  const requestId = uuidv7();
  const { settled } = getRequestsState().apply({
    kind: 'create_share_sheet',
    requestId,
    input: {
      url: resolvedUrl,
      userId: user.user_id,
      youtubeId,
    },
  });
  await settled;

  logger.info({ requestId, userId: user.user_id, url: resolvedUrl }, 'Request received');

  res.status(202).json({
    requestId,
    status: 'downloading',
    message: `Got it${user.role === 'kid' ? `, ${user.display_name}` : ''}. Working on it.`,
    pwaUrl: pwaFeedUrl(user.user_id),
  });
});

// GET /feed?user=... — timeline feed, day-grouped, anchored by added_at
// Returns: { days: [{ date: 'YYYY-MM-DD', label: 'Today'|'Yesterday'|'Mon 7 Apr', sections?: [...], cards: [...] }] }
requestsRouter.get('/feed', (req: Request, res: Response) => {
  const { userId, user: userName } = req.query as { userId?: string; user?: string };
  const lookupValue = userId ?? userName;
  if (!lookupValue) throw new ValidationError('userId or user query param required');
  const found = resolveUserByIdOrName(lookupValue);

  const rows = db.prepare(`
    SELECT
      request_id, url, youtube_id, youtube_channel_id, title, channel, status, file_state,
      rejection_reason, nginx_url, thumbnail_url, duration_secs,
      requested_at, added_at, watched_at, saved_at, source
    FROM requests
    WHERE user_id = ?
      AND status NOT IN ('dismissed', 'deleted')
      AND NOT (source = 'channel_subscription' AND status IN ('pending', 'downloading'))
    ORDER BY added_at DESC
    LIMIT 200
  `).all(found.user_id) as Array<{
    request_id: string; url: string; youtube_id: string | null;
    youtube_channel_id: string | null;
    title: string | null; channel: string | null; status: string; file_state: string;
    rejection_reason: string | null; nginx_url: string | null;
    thumbnail_url: string | null; duration_secs: number | null;
    requested_at: string; added_at: string; watched_at: string | null;
    saved_at: string | null; source: string;
  }>;

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  for (const row of rows) {
    row.rejection_reason = displayRejectionReason(row.rejection_reason);
  }

  const dayMap = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = (row.added_at ?? row.requested_at).slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)!.push(row);
  }

  function dayLabel(date: string): string {
    if (date === todayStr) return 'Today';
    if (date === yesterdayStr) return 'Yesterday';
    const d = new Date(date + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  const days = Array.from(dayMap.entries()).map(([date, cards]) => {
    const base = { date, label: dayLabel(date), cards };
    if (date !== todayStr) return base;
    return {
      ...base,
      sections: [
        { id: 'requests', label: 'My requests', cards: cards.filter((c) => c.source === 'share_sheet') },
        { id: 'channels', label: 'From people you follow', cards: cards.filter((c) => c.source === 'channel_subscription') },
        { id: 'recommended', label: 'Picked for you', cards: cards.filter((c) => c.source === 'recommended') },
      ],
    };
  });

  res.json({ days });
});

// GET /requests/admin/pipeline — active + recent rejected requests across all users
requestsRouter.get('/admin/pipeline', async (_req: Request, res: Response) => {
  const active = db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.title, r.status,
           r.rejection_reason, r.requested_at, u.display_name AS user_name
    FROM requests r
    JOIN users u ON r.user_id = u.user_id
    WHERE r.status IN ('downloading', 'guard_review', 'parent_review', 'pending', 'approved')
    ORDER BY r.requested_at ASC
  `).all() as AdminRequestRow[];

  const recentRejected = readRecentRejectedRequestsForAdmin();

  const activeWithJobState = await Promise.all(
    active.map(async (r) => {
      let jobState: string | null = null;
      let progress: number | null = null;
      try {
        const job = await downloadQueue.getJob(r.request_id);
        jobState = job ? await job.getState() : null;
      } catch { /* Redis unavailable */ }
      if (r.status === 'downloading') {
        try {
          const val = await redis.get(`eddy:progress:${r.request_id}`);
          progress = val !== null ? parseInt(val, 10) : null;
        } catch { /* Redis unavailable */ }
      }
      return { ...r, rejection_reason: displayRejectionReason(r.rejection_reason), jobState, progress };
    })
  );

  for (const r of recentRejected) {
    r.rejection_reason = displayRejectionReason(r.rejection_reason);
  }

  res.json({ active: activeWithJobState, recentRejected });
});

// DELETE /requests/:id — hard-delete a request record
requestsRouter.delete('/:id', async (req: Request, res: Response) => {
  const requestId = req.params['id'];

  const row = db.prepare(`SELECT status FROM requests WHERE request_id = ?`).get(requestId) as
    | { status: string } | undefined;
  if (!row) throw new NotFoundError('request');

  // If still active, cancel queue job first
  if (['downloading', 'guard_review', 'parent_review', 'pending', 'approved'].includes(row.status)) {
    try {
      const job = await downloadQueue.getJob(requestId);
      await job?.remove();
    } catch { /* best-effort */ }
    try { await redis.del(`eddy:progress:${requestId}`); } catch { /* best-effort */ }
  }

  db.prepare(`DELETE FROM guard_eval WHERE request_id = ?`).run(requestId);
  db.prepare(`DELETE FROM requests WHERE request_id = ?`).run(requestId);
  logger.info({ requestId }, 'Request deleted');
  res.status(204).end();
});

// GET /requests/:id — polled by PWA to check status
requestsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = db.prepare(
    'SELECT request_id, user_id, youtube_id, youtube_channel_id, status, title, channel, rejection_reason, nginx_url, requested_at, watched_at, saved_at FROM requests WHERE request_id = ?'
  ).get(req.params['id']) as
    | {
        request_id: string; user_id: string; youtube_id: string | null;
        youtube_channel_id: string | null;
        status: string; title: string | null; channel: string | null;
        rejection_reason: string | null; nginx_url: string | null;
        requested_at: string;
        watched_at: string | null;
        saved_at: string | null;
      }
    | undefined;

  if (!row) throw new NotFoundError('request');

  let progress: number | null = null;
  if (row.status === 'downloading') {
    try {
      const val = await redis.get(`eddy:progress:${row.request_id}`);
      progress = val !== null ? parseInt(val, 10) : null;
    } catch {
      // Redis unavailable — omit progress rather than failing the request
    }
  }

  res.json({
    requestId: row.request_id,
    userId: row.user_id,
    videoId: row.youtube_id,
    youtubeChannelId: row.youtube_channel_id,
    status: row.status,
    progress,
    title: row.title,
    channel: row.channel,
    rejectionReason: displayRejectionReason(row.rejection_reason),
    videoUrl: row.nginx_url,
    requestedAt: row.requested_at,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
  });
});

// POST /requests/:id/watched — PWA marks video as watched
requestsRouter.post('/:id/watched', (req: Request, res: Response) => {
  getRequestsState().apply({ kind: 'mark_watched', requestId: req.params['id']! });
  res.status(204).end();
});

// POST /requests/:id/save — PWA bookmarks a card
requestsRouter.post('/:id/save', (req: Request, res: Response) => {
  db.prepare(
    `UPDATE requests SET saved_at = ? WHERE request_id = ? AND saved_at IS NULL`
  ).run(new Date().toISOString(), req.params['id']);
  res.status(204).end();
});

// DELETE /requests/:id/save — PWA removes bookmark
requestsRouter.delete('/:id/save', (req: Request, res: Response) => {
  db.prepare(
    `UPDATE requests SET saved_at = NULL WHERE request_id = ?`
  ).run(req.params['id']);
  res.status(204).end();
});

// POST /requests/:id/delete — soft-delete: marks record deleted, removes video file
requestsRouter.post('/:id/delete', (req: Request, res: Response) => {
  const requestId = req.params['id']!;
  const { result } = getRequestsState().apply({ kind: 'mark_soft_deleted', requestId });

  if (!result.transitioned) {
    if (result.currentStatus === null) throw new NotFoundError('request');
    return res
      .status(409)
      .json({ error: 'INVALID_STATE', message: `Cannot delete a request in status '${result.currentStatus}'` });
  }

  logger.info({ requestId }, 'Request soft-deleted');
  res.status(204).end();
});

// POST /requests/:id/cancel — PWA cancels an in-progress download
requestsRouter.post('/:id/cancel', (req: Request, res: Response) => {
  const requestId = req.params['id']!;
  const { result } = getRequestsState().apply({ kind: 'mark_cancelled', requestId });

  if (!result.transitioned) {
    if (result.currentStatus === null) throw new NotFoundError('request');
    return res
      .status(409)
      .json({ error: 'INVALID_STATE', message: `Cannot cancel a request in status '${result.currentStatus}'` });
  }

  logger.info({ requestId }, 'Request cancelled');
  res.status(204).end();
});

// POST /requests/:id/dismiss — PWA dismisses a request
requestsRouter.post('/:id/dismiss', (req: Request, res: Response) => {
  getRequestsState().apply({ kind: 'mark_dismissed', requestId: req.params['id']! });
  res.status(204).end();
});

// GET /requests?userId=... or ?user=... — list requests for a user
requestsRouter.get('/', (req: Request, res: Response) => {
  const { userId, user: userName } = req.query as { userId?: string; user?: string };
  const lookupValue = userId ?? userName;
  if (!lookupValue) throw new ValidationError('userId or user query param required');
  const resolvedUserId = resolveUserByIdOrName(lookupValue).user_id;

  const rows = db.prepare(`
    SELECT request_id, url, youtube_id, title, channel, status, rejection_reason, nginx_url, requested_at
    FROM requests
    WHERE user_id = ?
      AND status NOT IN ('watched', 'dismissed')
    ORDER BY requested_at DESC
    LIMIT 50
  `).all(resolvedUserId) as Array<{
    request_id: string; url: string; youtube_id: string | null;
    title: string | null; channel: string | null; status: string;
    rejection_reason: string | null; nginx_url: string | null; requested_at: string;
  }>;

  for (const row of rows) {
    row.rejection_reason = displayRejectionReason(row.rejection_reason);
  }

  res.json({ requests: rows });
});
