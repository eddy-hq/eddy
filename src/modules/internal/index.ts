import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { downloadQueue } from '../../queue';
import { sendVideoReady } from '../notifications';
import { checkStuckDownloads } from '../watchdog';
import { scoreForRequest, classifyThumbnail, classifyYtImage } from '../guard';
import { ollamaGenerate } from '../../ollama';
import type { DownloadJobData } from '../content';

export const internalRouter = Router();

// Internal routes use raw body so we can verify HMAC over the exact bytes sent.
// express.json() is bypassed for these routes — see server.ts for the rawBody setup.

function verifyHmac(rawBody: Buffer, signature: string): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', config.INTERNAL_HMAC_SECRET)
    .update(rawBody)
    .digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

interface DownloadedPayload {
  requestId: string;
  youtubeId: string;
  filePath: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
  title: string;
  channel: string;
  description: string;
  durationSecs: number;
  transcript: string | null;
}

// POST /internal/videos/:youtube_id/downloaded — called by Ubuntu worker on success
internalRouter.post('/videos/:youtube_id/downloaded', (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'No body' });
  }

  if (!verifyHmac(rawBody, sig)) {
    logger.warn({ youtubeId: req.params['youtube_id'] }, 'HMAC verification failed on internal callback');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: DownloadedPayload;
  try {
    payload = JSON.parse(rawBody.toString()) as DownloadedPayload;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { requestId, filePath, nginxUrl, thumbnailUrl, title, channel, description, durationSecs, transcript } = payload;

  const row = db.prepare(`
    UPDATE requests
    SET status        = 'ready',
        title         = @title,
        channel       = @channel,
        description   = @description,
        duration_secs = @duration_secs,
        transcript    = @transcript,
        file_path     = @file_path,
        nginx_url     = @nginx_url,
        thumbnail_url = @thumbnail_url,
        downloaded_at = @downloaded_at
    WHERE request_id = @request_id AND status = 'downloading'
    RETURNING user_id
  `).get({
    title,
    channel,
    description,
    duration_secs: durationSecs,
    transcript,
    file_path: filePath,
    nginx_url: nginxUrl,
    thumbnail_url: thumbnailUrl,
    downloaded_at: new Date().toISOString(),
    request_id: requestId,
  }) as { user_id: string } | undefined;

  logger.info({ requestId, youtubeId: req.params['youtube_id'] }, 'Request marked ready');

  if (row?.user_id) {
    void sendVideoReady(row.user_id, requestId, title);
  }

  res.status(204).end();
});

// POST /internal/requests/:id/rejected — called by Ubuntu worker on terminal failure
internalRouter.post('/requests/:id/rejected', (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'No body' });
  }

  if (!verifyHmac(rawBody, sig)) {
    logger.warn({ requestId: req.params['id'] }, 'HMAC verification failed on reject callback');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: { requestId: string; reason: string };
  try {
    payload = JSON.parse(rawBody.toString()) as { requestId: string; reason: string };
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  db.prepare(`
    UPDATE requests
    SET status = 'rejected', rejection_reason = @reason
    WHERE request_id = @request_id AND status = 'downloading'
  `).run({ request_id: payload.requestId, reason: payload.reason });

  logger.info({ requestId: payload.requestId, reason: payload.reason }, 'Request rejected by worker');
  res.status(204).end();
});

// GET /internal/health/queue — queue stats + stuck downloads (no auth — internal network only)
internalRouter.get('/health/queue', async (_req: Request, res: Response) => {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const stuck = db.prepare(`
    SELECT request_id, youtube_id, title, user_id, requested_at, status
    FROM requests
    WHERE status = 'downloading'
      AND requested_at < ?
    ORDER BY requested_at ASC
  `).all(cutoff) as Array<{
    request_id: string; youtube_id: string | null; title: string | null;
    user_id: string; requested_at: string; status: string;
  }>;

  const stuckWithJobState = await Promise.all(
    stuck.map(async (r) => {
      let jobState: string | null = null;
      try {
        const job = await downloadQueue.getJob(r.request_id);
        jobState = job ? await job.getState() : null;
      } catch { /* Redis unavailable */ }
      return {
        requestId: r.request_id,
        youtubeId: r.youtube_id,
        title: r.title,
        requestedAt: r.requested_at,
        stuckMins: Math.round((Date.now() - new Date(r.requested_at).getTime()) / 60_000),
        jobState,
      };
    })
  );

  let queueCounts = null;
  try {
    queueCounts = await downloadQueue.getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed');
  } catch { /* Redis unavailable */ }

  res.json({
    stuckCount: stuckWithJobState.filter((r) => r.jobState !== 'active').length,
    downloading: stuckWithJobState,
    queue: queueCounts,
  });
});

// POST /internal/requests/:id/retry — re-enqueue a stuck or failed download
internalRouter.post('/requests/:id/retry', async (req: Request, res: Response) => {
  const requestId = req.params['id'];

  const row = db.prepare(`
    SELECT request_id, youtube_id, url, status FROM requests WHERE request_id = ?
  `).get(requestId) as { request_id: string; youtube_id: string | null; url: string; status: string } | undefined;

  if (!row) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Request not found' });
  }

  if (!['downloading', 'failed'].includes(row.status)) {
    return res.status(400).json({ error: 'INVALID_STATE', message: `Cannot retry a request in status '${row.status}'` });
  }

  // Remove old BullMQ job if present
  try {
    const existing = await downloadQueue.getJob(requestId);
    await existing?.remove();
  } catch { /* ignore */ }

  const jobData: DownloadJobData = {
    requestId,
    youtubeId: row.youtube_id ?? '',
    url: row.url,
  };

  await downloadQueue.add('download', jobData, { jobId: requestId });

  db.prepare(`UPDATE requests SET status = 'downloading' WHERE request_id = ?`).run(requestId);
  logger.info({ requestId }, 'Manual retry enqueued');

  res.json({ ok: true, requestId, message: 'Re-enqueued' });
});

// GET /internal/backfill/pending-thumbs — list videos needing thumbnail generation (no HMAC, internal network only)
// ?force=1 returns all live videos regardless of whether thumbnail_url is already set
internalRouter.get('/backfill/pending-thumbs', (req: Request, res: Response) => {
  const force = req.query['force'] === '1';
  const rows = db.prepare(`
    SELECT youtube_id, file_path, duration_secs, added_at
    FROM requests
    WHERE file_state = 'live'
      AND status IN ('ready', 'watched')
      AND file_path IS NOT NULL
      AND youtube_id IS NOT NULL
      AND duration_secs IS NOT NULL
      ${force ? '' : 'AND thumbnail_url IS NULL'}
    ORDER BY added_at DESC
  `).all() as Array<{ youtube_id: string; file_path: string; duration_secs: number; added_at: string }>;

  res.json({ pending: rows });
});

// POST /internal/backfill/thumb/:youtube_id — write generated thumbnail URL back to DB
internalRouter.post('/backfill/thumb/:youtube_id', (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return res.status(400).json({ error: 'No body' });

  if (!verifyHmac(rawBody, sig)) {
    logger.warn({ youtubeId: req.params['youtube_id'] }, 'HMAC verification failed on backfill thumb update');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: { thumbnailUrl: string };
  try {
    payload = JSON.parse(rawBody.toString()) as { thumbnailUrl: string };
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  db.prepare(`
    UPDATE requests SET thumbnail_url = @thumbnail_url
    WHERE youtube_id = @youtube_id
  `).run({ thumbnail_url: payload.thumbnailUrl, youtube_id: req.params['youtube_id'] });

  logger.info({ youtubeId: req.params['youtube_id'] }, 'Thumbnail backfilled via worker');
  res.status(204).end();
});

// POST /internal/thumb/classify — called by Ubuntu worker; fetches YT thumbnail, classifies with Gemma vision
internalRouter.post('/thumb/classify', async (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') return res.status(401).json({ error: 'Missing signature' });

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return res.status(400).json({ error: 'No body' });

  if (!verifyHmac(rawBody, sig)) {
    logger.warn('HMAC verification failed on thumb classify request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: { youtubeId: string };
  try {
    payload = JSON.parse(rawBody.toString()) as { youtubeId: string };
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const style = await classifyThumbnail(payload.youtubeId);
  res.json({ style });
});

// POST /internal/thumb/classify-variant — classify an arbitrary YT thumbnail variant (e.g. hq1, hq2, hq3).
// Used by the worker during the editorial-selection chain for auto-generated frame thumbnails.
internalRouter.post('/thumb/classify-variant', async (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') return res.status(401).json({ error: 'Missing signature' });

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return res.status(400).json({ error: 'No body' });

  if (!verifyHmac(rawBody, sig)) {
    logger.warn('HMAC verification failed on thumb classify-variant request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: { youtubeId: string; variant: string };
  try {
    payload = JSON.parse(rawBody.toString()) as { youtubeId: string; variant: string };
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (typeof payload.youtubeId !== 'string' || typeof payload.variant !== 'string') {
    return res.status(400).json({ error: 'youtubeId and variant required' });
  }
  if (!/^(hq|mq|maxres|sd)?(default|[1-3])$/.test(payload.variant)) {
    return res.status(400).json({ error: 'unsupported variant' });
  }

  const style = await classifyYtImage(payload.youtubeId, payload.variant);
  res.json({ style });
});

// POST /internal/thumb/score-frame — proxy for Ubuntu worker to score a local frame against Gemma.
// Ollama binds to localhost on M4, so the worker can't hit it directly; this relays.
internalRouter.post('/thumb/score-frame', async (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') return res.status(401).json({ error: 'Missing signature' });

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return res.status(400).json({ error: 'No body' });

  if (!verifyHmac(rawBody, sig)) {
    logger.warn('HMAC verification failed on thumb score-frame request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: { image: string; prompt: string };
  try {
    payload = JSON.parse(rawBody.toString()) as { image: string; prompt: string };
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (typeof payload.image !== 'string' || typeof payload.prompt !== 'string') {
    return res.status(400).json({ error: 'image and prompt required' });
  }

  try {
    const raw = await ollamaGenerate(payload.prompt, undefined, [payload.image]);
    if (!raw.trim()) {
      logger.warn({ imageBytes: payload.image.length }, 'score-frame Ollama returned empty response');
    }
    res.json({ raw });
  } catch (err) {
    logger.warn({ err }, 'score-frame Ollama call failed');
    res.status(502).json({ error: String(err) });
  }
});

// POST /internal/watchdog/run — trigger an immediate watchdog check (for testing/ops)
internalRouter.post('/watchdog/run', (_req: Request, res: Response) => {
  void checkStuckDownloads().catch((err: unknown) => {
    logger.error({ err }, 'Manual watchdog check failed');
  });
  res.json({ ok: true, message: 'Watchdog check triggered' });
});

interface GuardScorePayload {
  requestId: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  transcript: string | null;
}

// POST /internal/guard/score — called by Ubuntu worker after metadata fetch, before download.
// Shadow mode (Phase 3): always returns proceed:true. Phase 6: flip to return real verdict.
internalRouter.post('/guard/score', async (req: Request, res: Response) => {
  const sig = req.headers['x-eddy-signature'];
  if (!sig || typeof sig !== 'string') {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return res.status(400).json({ error: 'No body' });

  if (!verifyHmac(rawBody, sig)) {
    logger.warn('HMAC verification failed on guard score request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: GuardScorePayload;
  try {
    payload = JSON.parse(rawBody.toString()) as GuardScorePayload;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const row = db.prepare('SELECT user_id FROM requests WHERE request_id = ?')
    .get(payload.requestId) as { user_id: string } | undefined;

  if (!row) {
    return res.status(404).json({ error: 'Request not found' });
  }

  // Write metadata now so the card shows title/channel during download
  db.prepare(`
    UPDATE requests SET title = @title, channel = @channel
    WHERE request_id = @request_id AND title IS NULL
  `).run({ title: payload.title, channel: payload.channel, request_id: payload.requestId });

  let verdict;
  try {
    verdict = await scoreForRequest({ ...payload, userId: row.user_id });
  } catch (err) {
    logger.error({ err, requestId: payload.requestId }, 'Guard score endpoint error');
    // Never block a download in shadow mode
    return res.json({ proceed: true, verdict: 'uncertain', reason: 'Guard error' });
  }

  // Shadow mode: always proceed regardless of verdict
  res.json({ proceed: true, verdict: verdict.verdict, reason: verdict.reason });
});
