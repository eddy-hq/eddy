import { Router, Request, Response } from 'express';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError } from '../../errors';
import { resolveUserByIdOrName } from '../users';
import { displayRejectionReason } from '../requests';
import { toPublicMediaUrl } from '../media';
import { searchVideosFlat, type SearchVideoFlat } from '../../ytdlp';

export const searchRouter = Router();

function ftsQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const escaped = tokens.map((w) => `"${w.replace(/"/g, '""')}"*`);
  // OR semantics: any matching token returns a result, ranked by how many match
  return escaped.join(' OR ');
}

// GET /search?q=&userId=
// Returns flat list of matching requests, ordered by recency.
searchRouter.get('/', (req: Request, res: Response) => {
  const { q, userId, user } = req.query as { q?: string; userId?: string; user?: string };
  if (!q?.trim()) throw new ValidationError('q required');

  const uid = resolveUserByIdOrName(userId ?? user).user_id;
  const matchExpr = ftsQuery(q.trim());

  const rows = db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.youtube_channel_id, r.title, r.channel, r.status, r.file_state,
           r.rejection_reason, r.nginx_url, r.thumbnail_url, r.duration_secs, r.why_text,
           r.requested_at, r.added_at, r.watched_at, r.saved_at, r.source
    FROM requests r
    WHERE r.rowid IN (
      SELECT rowid FROM requests_fts WHERE requests_fts MATCH ?
    )
    AND r.user_id = ?
    AND r.status NOT IN ('dismissed')
    ORDER BY r.added_at DESC
    LIMIT 50
  `).all(matchExpr, uid) as Array<{ rejection_reason: string | null; nginx_url: string | null; thumbnail_url: string | null }>;

  for (const r of rows) {
    r.rejection_reason = displayRejectionReason(r.rejection_reason);
    r.nginx_url = toPublicMediaUrl(r.nginx_url);
    r.thumbnail_url = toPublicMediaUrl(r.thumbnail_url);
  }

  res.json({ results: rows, query: q.trim() });
});

// GET /search/videos?q=&userId=
// Searches YouTube via yt-dlp, returns up to 10 results with in-library flag.
searchRouter.get('/videos', async (req: Request, res: Response) => {
  const { q, userId, user } = req.query as { q?: string; userId?: string; user?: string };
  if (!q?.trim()) throw new ValidationError('q required');

  const uid = resolveUserByIdOrName(userId ?? user).user_id;

  let videos: SearchVideoFlat[] = [];
  let searchError = false;
  try {
    videos = await searchVideosFlat(q.trim());
  } catch (err) {
    logger.error({ err }, 'Video search failed');
    searchError = true;
  }

  const videoIds = videos.map((v) => v.videoId);

  // Mark videos already in this user's library
  const inLibrary = new Set<string>();
  if (videoIds.length > 0) {
    const placeholders = videoIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT youtube_id FROM requests WHERE user_id = ? AND youtube_id IN (${placeholders})`
    ).all(uid, ...videoIds) as Array<{ youtube_id: string }>;
    rows.forEach((r) => inLibrary.add(r.youtube_id));
  }

  const results = videos.map((v) => ({ ...v, inLibrary: inLibrary.has(v.videoId) }));
  res.json({ results, searchError });
});
