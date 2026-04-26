/**
 * Eddy download worker — runs on Ubuntu.
 *
 * Connects to Redis (on Ubuntu), processes BullMQ download jobs, writes video
 * files to VIDEO_OUTPUT_PATH, then POSTs an HMAC-signed callback to the M4 API.
 *
 * Entry point: npm run worker
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Worker, Job } from 'bullmq';
import { redis, closeQueues, thumbsQueue } from '../queue';
import { config } from '../config';
import { logger } from '../logger';
import { fetchMetadata, downloadVideo } from '../modules/content/download';
import { triggerPlexScan } from '../modules/content/plex';
import { postSigned } from '../signed-channel';
import { generateThumbnail } from './thumb';
import type { DownloadJobData } from '../modules/content';
import type { DeleteJobData } from '../modules/requests';

interface ThumbJobData {
  requestId: string;
  youtubeId: string;
  filePath: string;
  durationSecs: number;
}

const PROGRESS_KEY = (requestId: string) => `eddy:progress:${requestId}`;

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

async function postGuardScore(payload: GuardScorePayload): Promise<GuardScoreResponse> {
  const resp = await postSigned('/internal/guard/score', payload, { timeoutMs: 30_000 });
  return (await resp.json()) as GuardScoreResponse;
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
      await postSigned(`/internal/requests/${requestId}/rejected`, { requestId, reason }).catch((cbErr: unknown) =>
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
      await postSigned(`/internal/requests/${requestId}/rejected`, { requestId, reason }).catch((cbErr: unknown) =>
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
    await postSigned(`/internal/requests/${requestId}/rejected`, { requestId, reason: guardResult.reason }).catch((cbErr: unknown) =>
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
  await postSigned(`/internal/videos/${youtubeId}/downloaded`, {
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

interface DeleteFailure {
  path: string;
  code: string;
}

// Worker-side soft-delete: the M4 has already marked the row deleted, so this
// is best-effort cleanup of the .mp4 + sidecars on Ubuntu disk. All five paths
// are attempted independently — a missing sidecar must not stop the .mp4
// being unlinked, and vice versa. ENOENT stays silent (file already absent —
// that's the goal); any other code is a real failure and surfaces both here
// and on the M4 via the callback.
async function processDeleteJob(job: Job<DeleteJobData>): Promise<void> {
  const { requestId, filePath } = job.data;
  const log = logger.child({ requestId, filePath });

  const base = filePath.replace(/\.[^.]+$/, '');
  const paths = [filePath, `${base}.en.vtt`, `${base}.en.srt`, `${base}.vtt`, `${base}.srt`];

  const results = await Promise.allSettled(paths.map((p) => fs.promises.unlink(p)));

  const failures: DeleteFailure[] = results.flatMap((r, i) => {
    if (r.status !== 'rejected') return [];
    const err = r.reason as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    return [{ path: paths[i]!, code: err.code ?? 'UNKNOWN' }];
  });

  if (failures.length > 0) {
    log.warn({ failures }, 'Some files failed to unlink — record still marked deleted');
  } else {
    log.info('Delete job complete');
  }

  // Callback to M4 reports outcome so non-ENOENT failures are visible in M4
  // logs — the original bug was that they were silently swallowed. Callback
  // failures don't re-throw: the row is already `deleted` and BullMQ retries
  // would only re-run unlinks on already-absent files.
  await postSigned(`/internal/requests/${requestId}/file-deleted`, {
    requestId,
    failures,
  }).catch((cbErr: unknown) => log.warn({ cbErr }, 'Failed to post file-deleted callback'));
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
  await postSigned(`/internal/backfill/thumb/${youtubeId}`, { thumbnailUrl }, { timeoutMs: 10_000 });
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

  // Delete worker: concurrency 1 — unlinks are cheap but serial keeps log lines
  // and callbacks ordered for any single request that's deleted then recreated.
  const deleteWorker = new Worker<DeleteJobData>('deletes', processDeleteJob, {
    connection: redis,
    concurrency: 1,
  });

  deleteWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, requestId: job.data.requestId }, 'Delete job completed');
  });

  deleteWorker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, requestId: job?.data.requestId, err }, 'Delete job failed');
  });

  logger.info('Download worker running');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
    await thumbsWorker.close();
    await deleteWorker.close();
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
