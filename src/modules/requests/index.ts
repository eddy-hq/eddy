import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError, NotFoundError } from '../../errors';
import { config } from '../../config';
import { downloadQueue, redis } from '../../queue';
import type { DownloadJobData } from '../content';
import { sendVideoReady } from '../notifications';

export const requestsRouter = Router();

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

  const isUuid = /^[0-9a-f-]{36}$/.test(lookupValue);
  const user = (isUuid
    ? db.prepare('SELECT user_id, display_name, role FROM users WHERE user_id = ?').get(lookupValue)
    : db.prepare('SELECT user_id, display_name, role FROM users WHERE lower(display_name) = lower(?)').get(lookupValue)
  ) as
    | { user_id: string; display_name: string; role: string }
    | undefined;

  if (!user) {
    throw new NotFoundError(`user ${lookupValue}`);
  }

  const youtubeId = extractYoutubeId(resolvedUrl);

  // Dedup: if this user already has an active request for the same video, return it
  if (youtubeId) {
    const existing = db.prepare(`
      SELECT request_id, status FROM requests
      WHERE user_id = ? AND youtube_id = ?
        AND status NOT IN ('rejected', 'dismissed', 'watched')
      ORDER BY requested_at DESC LIMIT 1
    `).get(user.user_id, youtubeId) as { request_id: string; status: string } | undefined;

    if (existing) {
      logger.info({ requestId: existing.request_id, youtubeId }, 'Returning existing request');
      // Re-send the ready notification in case the user missed it
      if (existing.status === 'ready') {
        const row = db.prepare('SELECT title FROM requests WHERE request_id = ?')
          .get(existing.request_id) as { title: string | null } | undefined;
        void sendVideoReady(user.user_id, existing.request_id, row?.title ?? youtubeId ?? '');
      }
      return res.status(202).json({
        requestId: existing.request_id,
        status: existing.status,
        message: `Got it${user.role === 'kid' ? `, ${user.display_name}` : ''}. Working on it.`,
        pwaUrl: pwaFeedUrl(user.user_id),
      });
    }
  }

  const requestId = uuidv7();
  const now = new Date().toISOString();

  // Phase 1: auto-approve and immediately mark downloading (worker picks it up momentarily)
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, status, decided_by, decided_at, requested_at, added_at)
    VALUES
      (@request_id, @user_id, @source, @url, @youtube_id, 'downloading', 'auto', @now, @now, @now)
  `).run({
    request_id: requestId,
    user_id: user.user_id,
    source: 'share_sheet',
    url: resolvedUrl,
    youtube_id: youtubeId,
    now,
  });

  logger.info({ requestId, userId: user.user_id, url: resolvedUrl }, 'Request received');

  const jobData: DownloadJobData = { requestId, youtubeId: youtubeId ?? '', url: resolvedUrl };
  await downloadQueue.add('download', jobData, { jobId: requestId });

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

  const isUuid = /^[0-9a-f-]{36}$/.test(lookupValue);
  const found = (isUuid
    ? db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(lookupValue)
    : db.prepare('SELECT user_id FROM users WHERE lower(display_name) = lower(?)').get(lookupValue)
  ) as { user_id: string } | undefined;
  if (!found) throw new NotFoundError(`user ${lookupValue}`);

  const rows = db.prepare(`
    SELECT
      request_id, url, youtube_id, title, channel, status, file_state,
      rejection_reason, nginx_url, thumbnail_url, duration_secs,
      requested_at, added_at, watched_at, saved_at, source
    FROM requests
    WHERE user_id = ?
      AND status NOT IN ('dismissed')
    ORDER BY added_at DESC
    LIMIT 200
  `).all(found.user_id) as Array<{
    request_id: string; url: string; youtube_id: string | null;
    title: string | null; channel: string | null; status: string; file_state: string;
    rejection_reason: string | null; nginx_url: string | null;
    thumbnail_url: string | null; duration_secs: number | null;
    requested_at: string; added_at: string; watched_at: string | null;
    saved_at: string | null; source: string;
  }>;

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

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
        { id: 'channels', label: 'From your channels', cards: cards.filter((c) => c.source === 'channel') },
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
  `).all() as Array<{
    request_id: string; url: string; youtube_id: string | null;
    title: string | null; status: string; rejection_reason: string | null;
    requested_at: string; user_name: string;
  }>;

  const recentRejected = db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.title, r.status,
           r.rejection_reason, r.requested_at, u.display_name AS user_name
    FROM requests r
    JOIN users u ON r.user_id = u.user_id
    WHERE r.status = 'rejected'
      AND r.requested_at > datetime('now', '-24 hours')
    ORDER BY r.requested_at DESC
    LIMIT 20
  `).all() as Array<{
    request_id: string; url: string; youtube_id: string | null;
    title: string | null; status: string; rejection_reason: string | null;
    requested_at: string; user_name: string;
  }>;

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
      return { ...r, jobState, progress };
    })
  );

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
    'SELECT request_id, status, title, rejection_reason, nginx_url FROM requests WHERE request_id = ?'
  ).get(req.params['id']) as
    | { request_id: string; status: string; title: string | null; rejection_reason: string | null; nginx_url: string | null }
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
    status: row.status,
    progress,
    title: row.title,
    rejectionReason: row.rejection_reason,
    videoUrl: row.nginx_url,
  });
});

// POST /requests/:id/watched — PWA marks video as watched
requestsRouter.post('/:id/watched', (req: Request, res: Response) => {
  db.prepare(
    `UPDATE requests SET status = 'watched', watched_at = ? WHERE request_id = ? AND status = 'ready'`
  ).run(new Date().toISOString(), req.params['id']);
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

// POST /requests/:id/cancel — PWA cancels an in-progress download
requestsRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  const requestId = req.params['id'];

  const row = db.prepare(
    `SELECT status FROM requests WHERE request_id = ?`
  ).get(requestId) as { status: string } | undefined;

  if (!row) throw new NotFoundError('request');

  const cancellable = ['downloading', 'guard_review', 'parent_review', 'pending', 'approved'];
  if (!cancellable.includes(row.status)) {
    return res.status(409).json({ error: 'INVALID_STATE', message: `Cannot cancel a request in status '${row.status}'` });
  }

  // Remove BullMQ job if still queued; ignore errors (job may be active or already gone)
  try {
    const job = await downloadQueue.getJob(requestId);
    await job?.remove();
  } catch { /* best-effort */ }

  // Clean up progress key
  try {
    await redis.del(`eddy:progress:${requestId}`);
  } catch { /* best-effort */ }

  db.prepare(`
    UPDATE requests SET status = 'rejected', rejection_reason = 'Cancelled'
    WHERE request_id = ? AND status IN ('downloading', 'guard_review', 'parent_review', 'pending', 'approved')
  `).run(requestId);

  logger.info({ requestId }, 'Request cancelled');
  res.status(204).end();
});

// POST /requests/:id/dismiss — PWA dismisses a request
requestsRouter.post('/:id/dismiss', (req: Request, res: Response) => {
  db.prepare(
    `UPDATE requests SET status = 'dismissed' WHERE request_id = ? AND status NOT IN ('downloading', 'guard_review', 'parent_review')`
  ).run(req.params['id']);
  res.status(204).end();
});

// GET /requests?userId=... or ?user=... — list requests for a user
requestsRouter.get('/', (req: Request, res: Response) => {
  const { userId, user: userName } = req.query as { userId?: string; user?: string };
  const lookupValue = userId ?? userName;
  if (!lookupValue) throw new ValidationError('userId or user query param required');

  const isUuid = /^[0-9a-f-]{36}$/.test(lookupValue);
  const found = (isUuid
    ? db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(lookupValue)
    : db.prepare('SELECT user_id FROM users WHERE lower(display_name) = lower(?)').get(lookupValue)
  ) as { user_id: string } | undefined;

  if (!found) throw new NotFoundError(`user ${lookupValue}`);
  const resolvedUserId = found.user_id;

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

  res.json({ requests: rows });
});
