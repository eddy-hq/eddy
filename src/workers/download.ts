/**
 * Eddy download worker — runs on Ubuntu.
 *
 * Connects to Redis (on Ubuntu), processes BullMQ download jobs, writes video
 * files to VIDEO_OUTPUT_PATH, then POSTs an HMAC-signed callback to the M4 API.
 *
 * Entry point: npm run worker
 */
import 'dotenv/config';
import crypto from 'crypto';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { redis, closeQueues } from '../queue';
import { config } from '../config';
import { logger } from '../logger';
import { fetchMetadata, downloadVideo } from '../modules/content/ytdlp';
import { triggerPlexScan } from '../modules/content/plex';
import type { DownloadJobData } from '../modules/content';

const PROGRESS_KEY = (requestId: string) => `eddy:progress:${requestId}`;

interface CallbackPayload {
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

interface RejectPayload {
  requestId: string;
  reason: string;
}

function signBody(body: string): string {
  return `sha256=${crypto
    .createHmac('sha256', config.INTERNAL_HMAC_SECRET)
    .update(body)
    .digest('hex')}`;
}

async function postCallback(payload: CallbackPayload): Promise<void> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    logger.warn('M4_INTERNAL_URL not set — skipping callback (DB will not be updated)');
    return;
  }

  const url = `${baseUrl}/internal/videos/${payload.youtubeId}/downloaded`;
  const body = JSON.stringify(payload);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Eddy-Signature': signBody(body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`M4 callback returned ${resp.status}`);
  }
}

async function postRejectCallback(payload: RejectPayload): Promise<void> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    logger.warn('M4_INTERNAL_URL not set — skipping reject callback');
    return;
  }

  const url = `${baseUrl}/internal/requests/${payload.requestId}/rejected`;
  const body = JSON.stringify(payload);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Eddy-Signature': signBody(body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`M4 reject callback returned ${resp.status}`);
  }
}

async function processJob(job: Job<DownloadJobData>): Promise<void> {
  const { requestId, youtubeId, url } = job.data;
  const log = logger.child({ requestId, youtubeId });

  log.info('Picked up download job');

  // Fetch metadata
  let metadata;
  try {
    metadata = await fetchMetadata(url);
  } catch (err: unknown) {
    const isTerminal = (err as { terminal?: boolean }).terminal === true;
    log.warn({ err, isTerminal }, 'Metadata fetch failed');
    if (isTerminal) {
      const reason = (err as Error).message;
      await postRejectCallback({ requestId, reason }).catch((cbErr: unknown) =>
        log.error({ cbErr }, 'Failed to post rejection callback')
      );
      return;
    }
    throw err;
  }

  // Download directly to output directory
  log.info('Downloading video');
  await redis.set(PROGRESS_KEY(requestId), 0, 'EX', 3600);

  let filePath: string;
  try {
    filePath = await downloadVideo(youtubeId, url, (pct) => {
      void redis.set(PROGRESS_KEY(requestId), pct, 'EX', 3600);
    });
  } catch (err: unknown) {
    await redis.del(PROGRESS_KEY(requestId));
    const isTerminal = (err as { terminal?: boolean }).terminal === true;
    log.warn({ err, isTerminal }, 'Download failed');
    if (isTerminal) {
      const reason = (err as Error).message;
      await postRejectCallback({ requestId, reason }).catch((cbErr: unknown) =>
        log.error({ cbErr }, 'Failed to post rejection callback')
      );
      return;
    }
    throw err;
  }

  await redis.del(PROGRESS_KEY(requestId));
  log.info({ filePath }, 'Download complete');

  // Plex scan — localhost on Ubuntu
  void triggerPlexScan();

  // Build nginx URL
  const nginxBase = config.NGINX_VIDEO_BASE_URL ?? '';
  const nginxUrl = nginxBase
    ? `${nginxBase.replace(/\/$/, '')}/${path.basename(filePath)}`
    : null;

  // Callback to M4 — M4 writes SQLite and sends ntfy
  await postCallback({
    requestId,
    youtubeId,
    filePath,
    nginxUrl,
    title: metadata.title,
    channel: metadata.channel,
    description: metadata.description,
    durationSecs: metadata.durationSecs,
    transcript: metadata.transcript,
  });

  log.info({ nginxUrl }, 'Job complete');
}

async function start(): Promise<void> {
  logger.info('Eddy download worker starting');

  const worker = new Worker<DownloadJobData>('downloads', processJob, {
    connection: redis,
    concurrency: 2,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, requestId: job.data.requestId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, requestId: job?.data.requestId, err }, 'Job failed');
  });

  logger.info('Download worker running');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
    await closeQueues();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err: unknown) => {
  logger.error({ err }, 'Worker startup failed');
  process.exit(1);
});
