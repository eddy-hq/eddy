import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError } from '../../errors';
import { resolveUserByIdOrName } from '../users';

const execFileAsync = promisify(execFile);
const YTDLP_BIN_M4 = process.env['YTDLP_BIN_M4'] ?? '/opt/homebrew/bin/yt-dlp';

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

// GET /search/videos?q=&userId=
// Searches YouTube via yt-dlp, returns up to 10 results with in-library flag.
searchRouter.get('/videos', async (req: Request, res: Response) => {
  const { q, userId, user } = req.query as { q?: string; userId?: string; user?: string };
  if (!q?.trim()) throw new ValidationError('q required');

  const uid = resolveUserByIdOrName(userId ?? user).user_id;

  let stdout = '';
  let searchError = false;
  try {
    ({ stdout } = await execFileAsync(YTDLP_BIN_M4, [
      `ytsearch10:${q.trim()}`,
      '--flat-playlist', '--dump-json', '--no-download', '--quiet',
    ], { maxBuffer: 5 * 1024 * 1024, timeout: 20_000 }));
  } catch (err) {
    logger.error({ err, ytdlpBin: YTDLP_BIN_M4 }, 'Video search failed');
    searchError = true;
  }

  const videoIds: string[] = [];
  const videos: Array<{
    videoId: string; title: string; channel: string; channelId: string;
    durationSecs: number | null; thumbnailUrl: string | null; url: string;
  }> = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      const videoId = item['id'] as string | undefined;
      if (!videoId) continue;
      videoIds.push(videoId);
      const thumbs = (item['thumbnails'] as Array<{ url: string; height?: number }> | undefined) ?? [];
      const thumb = thumbs.find((t) => t.height && t.height >= 180) ?? thumbs[0];
      videos.push({
        videoId,
        title:       String(item['title'] ?? ''),
        channel:     String(item['channel'] ?? item['uploader'] ?? ''),
        channelId:   String(item['channel_id'] ?? ''),
        durationSecs: typeof item['duration'] === 'number' ? item['duration'] : null,
        thumbnailUrl: thumb?.url ?? null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    } catch { /* skip malformed */ }
  }

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
