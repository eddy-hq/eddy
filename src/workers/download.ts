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
import fs from 'fs';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { redis, closeQueues, thumbsQueue } from '../queue';
import { config } from '../config';
import { logger } from '../logger';
import { fetchMetadata, downloadVideo } from '../modules/content/ytdlp';
import { triggerPlexScan } from '../modules/content/plex';
import { generateThumbnail } from './thumb';
import type { DownloadJobData } from '../modules/content';

interface ThumbJobData {
  requestId: string;
  youtubeId: string;
  filePath: string;
  durationSecs: number;
}

const PROGRESS_KEY = (requestId: string) => `eddy:progress:${requestId}`;

interface CallbackPayload {
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

interface RejectPayload {
  requestId: string;
  reason: string;
}

interface GuardScorePayload {
  requestId: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  transcript: string | null;
}

interface GuardScoreResponse {
  proceed: boolean;
  verdict: string;
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

async function postGuardScore(payload: GuardScorePayload): Promise<GuardScoreResponse> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    logger.debug('M4_INTERNAL_URL not set — skipping guard score');
    return { proceed: true, verdict: 'uncertain', reason: 'Guard not configured' };
  }

  const url = `${baseUrl}/internal/guard/score`;
  const body = JSON.stringify(payload);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Eddy-Signature': signBody(body),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Guard score returned ${resp.status}`);
  }

  return (await resp.json()) as GuardScoreResponse;
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

  // Start guard score and download concurrently — guard runs while video downloads
  log.info('Starting guard score and download in parallel');
  await redis.set(PROGRESS_KEY(requestId), 0, 'EX', 3600);

  const guardPromise = postGuardScore({
    requestId,
    url,
    title: metadata.title,
    channel: metadata.channel,
    description: metadata.description,
    transcript: metadata.transcript,
  }).then((r) => {
    log.info({ verdict: r.verdict }, 'Guard scored');
    return r;
  }).catch((err) => {
    log.warn({ err }, 'Guard score failed — proceeding (shadow mode)');
    return { proceed: true, verdict: 'uncertain', reason: 'Guard error' } as GuardScoreResponse;
  });

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

  // Await guard result — usually already resolved by the time download finishes
  const guardResult = await guardPromise;

  if (!guardResult.proceed) {
    log.warn({ verdict: guardResult.verdict, reason: guardResult.reason }, 'Guard blocked — deleting downloaded file');
    try {
      fs.unlinkSync(filePath);
      log.info({ filePath }, 'Deleted blocked video file');
    } catch (err) {
      log.error({ err, filePath }, 'Failed to delete blocked video file');
    }
    await postRejectCallback({ requestId, reason: guardResult.reason }).catch((cbErr: unknown) =>
      log.error({ cbErr }, 'Failed to post guard rejection callback')
    );
    return;
  }
  log.info({ filePath }, 'Download complete');

  // Plex scan — localhost on Ubuntu
  void triggerPlexScan();

  // Build nginx URL
  const nginxBase = config.NGINX_VIDEO_BASE_URL ?? '';
  const nginxUrl = nginxBase
    ? `${nginxBase.replace(/\/$/, '')}/${path.basename(filePath)}`
    : null;

  // Immediate fallback thumbnail — the editorial-first upgrade runs in a separate
  // queue so the video is available without waiting on Gemma.
  const thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;

  // Callback to M4 — M4 writes SQLite and sends ntfy
  await postCallback({
    requestId,
    youtubeId,
    filePath,
    nginxUrl,
    thumbnailUrl,
    title: metadata.title,
    channel: metadata.channel,
    description: metadata.description,
    durationSecs: metadata.durationSecs,
    transcript: metadata.transcript,
  });

  // Enqueue the thumbnail-upgrade job — non-blocking, processed serially.
  await thumbsQueue.add('upgrade', {
    requestId,
    youtubeId,
    filePath,
    durationSecs: metadata.durationSecs,
  } satisfies ThumbJobData, { jobId: `thumb:upgrade:${requestId}` });

  log.info({ nginxUrl }, 'Job complete');
}

async function processThumbJob(job: Job<ThumbJobData>): Promise<void> {
  const { requestId, youtubeId, filePath, durationSecs } = job.data;
  const log = logger.child({ requestId, youtubeId });

  if (!fs.existsSync(filePath)) {
    log.warn({ filePath }, 'Video file gone before thumbnail upgrade — skipping');
    return;
  }

  const thumbnailUrl = await generateThumbnail(youtubeId, filePath, durationSecs);
  if (!thumbnailUrl) {
    log.info('Thumbnail upgrade returned no URL — leaving fallback in place');
    return;
  }

  // Push the upgraded URL back to M4. Reuses the backfill endpoint.
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    log.warn('M4_INTERNAL_URL not set — cannot persist upgraded thumbnail');
    return;
  }

  const body = JSON.stringify({ thumbnailUrl });
  const resp = await fetch(`${baseUrl}/internal/backfill/thumb/${youtubeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Eddy-Signature': signBody(body) },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to persist upgraded thumbnail: HTTP ${resp.status}`);
  }
  log.info({ thumbnailUrl }, 'Thumbnail upgraded');
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

  // Thumbnail-upgrade worker: concurrency 1 keeps Gemma pressure low and predictable.
  const thumbsWorker = new Worker<ThumbJobData>('thumbs', processThumbJob, {
    connection: redis,
    concurrency: 1,
  });

  thumbsWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, requestId: job.data.requestId }, 'Thumb upgrade completed');
  });

  thumbsWorker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, requestId: job?.data.requestId, err }, 'Thumb upgrade failed');
  });

  logger.info('Download worker running');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
    await thumbsWorker.close();
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
