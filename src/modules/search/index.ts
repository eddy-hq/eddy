import { Router, Request, Response } from 'express';
import { db } from '../../db/client';
import { ValidationError, NotFoundError } from '../../errors';

export const searchRouter = Router();

function ftsQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const escaped = tokens.map((w) => `"${w.replace(/"/g, '""')}"*`);
  // OR semantics: any matching token returns a result, ranked by how many match
  return escaped.join(' OR ');
}

function resolveUserId(value: string | undefined): string {
  if (!value) throw new ValidationError('userId required');
  const isUuid = /^[0-9a-f-]{36}$/.test(value);
  const found = (isUuid
    ? db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(value)
    : db.prepare('SELECT user_id FROM users WHERE lower(display_name) = lower(?)').get(value)
  ) as { user_id: string } | undefined;
  if (!found) throw new NotFoundError(`user ${value}`);
  return found.user_id;
}

// GET /search?q=&userId=
// Returns flat list of matching requests, ordered by recency.
searchRouter.get('/', (req: Request, res: Response) => {
  const { q, userId, user } = req.query as { q?: string; userId?: string; user?: string };
  if (!q?.trim()) throw new ValidationError('q required');

  const uid = resolveUserId(userId ?? user);
  const matchExpr = ftsQuery(q.trim());

  const rows = db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.title, r.channel, r.status, r.file_state,
           r.rejection_reason, r.nginx_url, r.thumbnail_url, r.duration_secs,
           r.requested_at, r.added_at, r.watched_at, r.saved_at, r.source
    FROM requests r
    WHERE r.rowid IN (
      SELECT rowid FROM requests_fts WHERE requests_fts MATCH ?
    )
    AND r.user_id = ?
    AND r.status NOT IN ('dismissed')
    ORDER BY r.added_at DESC
    LIMIT 50
  `).all(matchExpr, uid);

  res.json({ results: rows, query: q.trim() });
});
