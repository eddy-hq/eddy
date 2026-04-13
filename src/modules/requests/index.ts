import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError, NotFoundError } from '../../errors';

export const requestsRouter = Router();

const YOUTUBE_REGEX = /^https?:\/\/(www\.)?(youtube\.com\/watch\?.*v=|youtu\.be\/)[\w-]+/;

function extractYoutubeId(url: string): string | null {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// POST /requests — called by iOS Shortcut
requestsRouter.post('/', (req: Request, res: Response) => {
  const { url, userId } = req.body as { url?: string; userId?: string };

  if (!url || typeof url !== 'string') {
    throw new ValidationError('url is required');
  }
  if (!url.match(YOUTUBE_REGEX)) {
    throw new ValidationError('url must be a YouTube URL');
  }
  if (!userId || typeof userId !== 'string') {
    throw new ValidationError('userId is required');
  }

  // Verify user exists
  const user = db.prepare('SELECT user_id, display_name, role FROM users WHERE user_id = ?').get(userId) as
    | { user_id: string; display_name: string; role: string }
    | undefined;

  if (!user) {
    throw new NotFoundError(`user ${userId}`);
  }

  const youtubeId = extractYoutubeId(url);
  const requestId = uuidv7();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, status, requested_at)
    VALUES
      (@request_id, @user_id, @source, @url, @youtube_id, @status, @requested_at)
  `).run({
    request_id: requestId,
    user_id: userId,
    source: 'share_sheet',
    url,
    youtube_id: youtubeId,
    status: 'pending',
    requested_at: now,
  });

  logger.info({ requestId, userId: user.display_name, url }, 'Request received');

  res.status(202).json({
    requestId,
    status: 'pending',
    message: `Got it${user.role === 'kid' ? `, ${user.display_name}` : ''}. Working on it.`,
  });
});

// GET /requests/:id — polled by PWA to check status
requestsRouter.get('/:id', (req: Request, res: Response) => {
  const row = db.prepare(
    'SELECT request_id, status, title, rejection_reason, nginx_url FROM requests WHERE request_id = ?'
  ).get(req.params['id']) as
    | { request_id: string; status: string; title: string | null; rejection_reason: string | null; nginx_url: string | null }
    | undefined;

  if (!row) throw new NotFoundError('request');

  res.json({
    requestId: row.request_id,
    status: row.status,
    title: row.title,
    rejectionReason: row.rejection_reason,
    videoUrl: row.nginx_url,
  });
});

// GET /requests?userId=... — list requests for a user
requestsRouter.get('/', (req: Request, res: Response) => {
  const { userId } = req.query as { userId?: string };
  if (!userId) throw new ValidationError('userId query param required');

  const rows = db.prepare(`
    SELECT request_id, url, youtube_id, title, status, rejection_reason, nginx_url, requested_at
    FROM requests
    WHERE user_id = ?
    ORDER BY requested_at DESC
    LIMIT 50
  `).all(userId) as Array<{
    request_id: string; url: string; youtube_id: string | null;
    title: string | null; status: string; rejection_reason: string | null;
    nginx_url: string | null; requested_at: string;
  }>;

  res.json({ requests: rows });
});
