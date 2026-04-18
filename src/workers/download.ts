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
import { redis, closeQueues } from '../queue';
import { config } from '../config';
import { logger } from '../logger';
import { fetchMetadata, downloadVideo } from '../modules/content/ytdlp';
import { triggerPlexScan } from '../modules/content/plex';
import { generateThumbnail } from './thumb';
import type { DownloadJobData } from '../modules/content';

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

interface ThumbClassifyResponse {
  style: 'editorial' | 'slop';
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

async function postThumbClassify(youtubeId: string): Promise<ThumbClassifyResponse> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) return { style: 'slop' };

  const body = JSON.stringify({ youtubeId });
  const resp = await fetch(`${baseUrl}/internal/thumb/classify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Eddy-Signature': signBody(body),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) throw new Error(`Thumb classify returned ${resp.status}`);
  return (await resp.json()) as ThumbClassifyResponse;
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

  // Fire thumbnail classification immediately — youtubeId is known, runs while metadata+download proceed
  const thumbClassifyPromise = postThumbClassify(youtubeId).catch((err) => {
    log.warn({ err }, 'Thumb classify failed — will generate local thumbnail');
    return { style: 'slop' as const };
  });

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

  // Decide thumbnail: editorial YT CDN image or locally generated stylised frame
  const thumbClassify = await thumbClassifyPromise;
  let thumbnailUrl: string | null;

  if (thumbClassify.style === 'editorial') {
    thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
    log.info({ youtubeId }, 'Editorial thumbnail — using YT CDN');
  } else {
    thumbnailUrl = await generateThumbnail(youtubeId, filePath, metadata.durationSecs);
    if (!thumbnailUrl) log.info({ youtubeId }, 'Thumbnail unavailable — continuing without it');
  }

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
