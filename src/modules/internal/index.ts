import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';

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

  db.prepare(`
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
    WHERE request_id = @request_id
  `).run({
    title,
    channel,
    description,
    duration_secs: durationSecs,
    transcript,
    file_path: filePath,
    nginx_url: nginxUrl,
    downloaded_at: new Date().toISOString(),
    request_id: requestId,
  });

  logger.info({ requestId, youtubeId: req.params['youtube_id'] }, 'Request marked ready');

  res.status(204).end();
});
