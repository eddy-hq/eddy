import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { downloadQueue } from '../../queue';
import { sendVideoReady } from '../notifications';
import { checkStuckDownloads } from '../watchdog';
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

  const { requestId, filePath, nginxUrl, title, channel, description, durationSecs, transcript } = payload;

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

// POST /internal/watchdog/run — trigger an immediate watchdog check (for testing/ops)
internalRouter.post('/watchdog/run', (_req: Request, res: Response) => {
  void checkStuckDownloads().catch((err: unknown) => {
    logger.error({ err }, 'Manual watchdog check failed');
  });
  res.json({ ok: true, message: 'Watchdog check triggered' });
});
