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
import { Worker, Job, DelayedError } from 'bullmq';
import { redis, closeQueues, thumbsQueue } from '../queue';
import { config } from '../config';
import { logger } from '../logger';
import { fetchMetadata, downloadVideo, attemptsExhausted } from '../modules/content/download';
import { botDetectionCooldownMs, engageBotDetectionCooldown } from '../botdetect';
import { triggerPlexScan, updatePlexMetadata } from '../modules/content/plex';
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

const LIVE_BROADCAST_RETRY_MS = 30 * 60 * 1000;

async function processJob(job: Job<DownloadJobData>, token?: string): Promise<void> {
  const { requestId, youtubeId, url, mode } = job.data;
  // Restore-mode (issue #116) re-downloads a previously-recycled file: the
  // original guard verdict already approved this video, so we skip the
  // scoring round trip and post the completion callback to the /restored
  // endpoint, which preserves status instead of flipping to ready.
  const isRestore = mode === 'restore';
  const log = logger.child({ requestId, youtubeId, ...(isRestore ? { mode: 'restore' } : {}) });

  log.info(isRestore ? 'Picked up restore job' : 'Picked up download job');

  // Stand down while a bot-detection cooldown is active (#185). Park the job in
  // BullMQ's delayed state until the window passes rather than spending a retry
  // hammering a blocked IP. moveToDelayed doesn't consume an attempt, so a long
  // block parks the request (visible as `delayed`, watchdog leaves it alone)
  // instead of failing it; the wake jitter staggers parked jobs so they don't
  // all re-stampede the moment the cooldown lifts.
  const cooldownMs = await botDetectionCooldownMs(redis);
  if (cooldownMs > 0) {
    const wakeJitterMs = Math.floor(Math.random() * 30_000);
    log.warn({ cooldownMs }, 'Bot-detection cooldown active — parking download in delayed state');
    await job.moveToDelayed(Date.now() + cooldownMs + wakeJitterMs, token);
    throw new DelayedError();
  }

  // Surface 0% as soon as the job is picked up so the PWA card replaces its
  // metadata-phase spinner with a moving bar instead of going spinner→jump.
  await redis.set(PROGRESS_KEY(requestId), 0, 'EX', 3600);

  // Fetch metadata
  let metadata;
  try {
    metadata = await fetchMetadata(url);
  } catch (err: unknown) {
    const isTerminal = (err as { terminal?: boolean }).terminal === true;
    const isLive = (err as { isLive?: boolean }).isLive === true;
    log.warn({ err, isTerminal, isLive }, 'Metadata fetch failed');
    if (isTerminal) {
      // Terminal: status flips to 'rejected' on the M4, so progress is hidden anyway.
      await redis.del(PROGRESS_KEY(requestId));
      const reason = (err as Error).message;
      await postSigned(`/internal/requests/${requestId}/rejected`, { requestId, reason }).catch((cbErr: unknown) =>
        log.error({ cbErr }, 'Failed to post rejection callback')
      );
      return;
    }
    if (isLive) {
      // Park the job in BullMQ's `delayed` state rather than letting the retry
      // budget burn down to `failed` and trigger the watchdog re-enqueue path
      // (which alerts every cycle). The request stays in `downloading` on the
      // PWA, the 0% bar stays put, and the next attempt fires automatically
      // once the delay elapses — by which point the VOD has usually landed.
      log.info({ retryInMins: LIVE_BROADCAST_RETRY_MS / 60_000 }, 'Live broadcast — parking job in delayed state');
      await job.moveToDelayed(Date.now() + LIVE_BROADCAST_RETRY_MS, token);
      throw new DelayedError();
    }
    // Non-terminal: BullMQ retries with backoff. Leave the 0% in place so the
    // PWA's bar holds steady instead of flickering back to a spinner. If this
    // was bot-detection, arm the cooldown first so the retry parks (#185).
    if ((err as { botDetection?: boolean }).botDetection) {
      await engageBotDetectionCooldown(redis, config.YTDLP_BOTDETECT_COOLDOWN_SECS, 'metadata');
    }
    throw err;
  }

  // Start guard score (skipped on restore) and download concurrently — guard
  // runs while video downloads.
  log.info(isRestore ? 'Starting download (guard skipped — restore)' : 'Starting guard score and download in parallel');
  // Metadata done — bump to the unified scale's 5% floor before yt-dlp opens its first stream.
  await redis.set(PROGRESS_KEY(requestId), 5, 'EX', 3600);

  // Restore: the original verdict already approved this video, and re-evaluating
  // would (a) burn Gemma time, (b) risk a different verdict if the model has
  // drifted, and (c) write a new guard_eval row the acceptance criteria
  // explicitly forbid. Synthesise the same "proceed" shape so the rest of the
  // pipeline stays uniform.
  const guardPromise: Promise<GuardScoreResponse> = isRestore
    ? Promise.resolve({ proceed: true, verdict: 'restore', reason: 'Restore — guard skipped' })
    : postGuardScore({
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
    // Non-terminal download failure. Arm the cooldown on bot-detection so the
    // BullMQ retry parks rather than hammers the blocked IP (#185).
    if ((err as { botDetection?: boolean }).botDetection) {
      await engageBotDetectionCooldown(redis, config.YTDLP_BOTDETECT_COOLDOWN_SECS, 'download');
    }
    throw err;
  }

  // Await guard result — usually already resolved by the time download finishes
  const guardResult = await guardPromise;

  if (!guardResult.proceed) {
    await redis.del(PROGRESS_KEY(requestId));
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

  // Build nginx URL
  const nginxBase = config.NGINX_VIDEO_BASE_URL ?? '';
  const nginxUrl = nginxBase
    ? `${nginxBase.replace(/\/$/, '')}/${path.basename(filePath)}`
    : null;

  // Immediate fallback thumbnail — the editorial-first upgrade runs in a separate
  // queue so the video is available without waiting on Gemma.
  const thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;

  // Plex scan + metadata. Awaited so item title/summary/poster are set before
  // the M4 callback flips status to ready. Best-effort — both calls warn-log
  // on failure and return without throwing.
  await triggerPlexScan();
  await updatePlexMetadata({
    filePath,
    title: metadata.title,
    summary: metadata.description,
    posterUrl: thumbnailUrl,
  });

  // Final 100-tick is written immediately before the callback flips status to
  // ready, so any PWA poll catching the small window sees a full bar instead
  // of a freeze-then-flip. Long TTL — request endpoint stops returning progress
  // once status leaves 'downloading', so the key just decays harmlessly.
  await redis.set(PROGRESS_KEY(requestId), 100, 'EX', 3600);

  // Capture on-disk size for the per-user recycler budget (issue #114). The
  // file is local to this worker host (no rsync; nginx/Plex read this same
  // mount), so a sync stat is the natural and cheapest measurement. Log-and-
  // continue on stat failure: the row should still flip to ready, and the
  // backfill script will fill the bytes in later. Sending null on stat error
  // is preferable to silently posting a wrong value.
  let fileSizeBytes: number | null = null;
  try {
    fileSizeBytes = fs.statSync(filePath).size;
  } catch (err) {
    log.warn({ err, filePath }, 'Failed to stat downloaded file for size — leaving file_size_bytes null');
  }

  // Callback to M4. Restore routes to /restored so the M4 fires mark_restored
  // (status preserved, recycled_at cleared); fresh downloads route to
  // /downloaded so the M4 fires mark_downloaded (status → ready, video_ready
  // notification). The /restored payload is narrower because title / channel
  // / description / transcript / youtube_channel_id were captured on the
  // original download and don't need rewriting.
  if (isRestore) {
    await postSigned(`/internal/videos/${youtubeId}/restored`, {
      requestId,
      youtubeId,
      filePath,
      nginxUrl,
      thumbnailUrl,
      fileSizeBytes,
    });
  } else {
    await postSigned(`/internal/videos/${youtubeId}/downloaded`, {
      requestId,
      youtubeId,
      filePath,
      nginxUrl,
      thumbnailUrl,
      title: metadata.title,
      channel: metadata.channel,
      youtubeChannelId: metadata.youtubeChannelId,
      description: metadata.description,
      durationSecs: metadata.durationSecs,
      transcript: metadata.transcript,
      publishedAt: metadata.publishedAt,
      fileSizeBytes,
    });
  }

  // Enqueue the thumbnail-upgrade job — non-blocking, processed serially.
  // Skipped on restore: the editorial-first upgrade ran on the original
  // download and any chosen frame is still in the row's thumbnail_url
  // (preserved via COALESCE in mark_restored). Re-running would burn
  // Gemma time for no UX benefit.
  if (!isRestore) {
    await thumbsQueue.add('upgrade', {
      requestId,
      youtubeId,
      filePath,
      durationSecs: metadata.durationSecs,
    } satisfies ThumbJobData, { jobId: `thumb:upgrade:${requestId}` });
  }

  log.info({ nginxUrl }, isRestore ? 'Restore job complete' : 'Job complete');
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

  // Concurrency 1: serialise downloads so the worker never runs two extractions
  // at once on the shared residential IP. Throughput isn't the constraint here
  // (household does ~3–15/day) — politeness is, and bursting parallel extractor
  // passes is exactly what trips the throttle. Was 2.
  const worker = new Worker<DownloadJobData>('downloads', processJob, {
    connection: redis,
    concurrency: 1,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, requestId: job.data.requestId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, requestId: job?.data.requestId, err }, 'Job failed');
    // #183: own the terminal transition on attempt-exhaustion. When the retry
    // budget is spent the BullMQ job dies in the `failed` zset, but nothing
    // moves the request off `downloading` — it orphans there until the
    // (unreliable) watchdog escalation maybe rescues it. Post a callback so the
    // M4 flips it to `failed` directly. mark_failed gates on `downloading`, so a
    // row that already moved on (cancelled / late success) is a safe no-op.
    // Cooldown parks (DelayedError) don't reach here, so a bot-detection block
    // parks instead of exhausting — this fires for genuinely failing downloads.
    if (job && attemptsExhausted(job.attemptsMade, job.opts.attempts)) {
      const { requestId } = job.data;
      void postSigned(`/internal/requests/${requestId}/failed`, {
        requestId,
        reason: 'Download attempts exhausted',
      }).catch((cbErr: unknown) =>
        logger.error({ cbErr, requestId }, 'Failed to post attempts-exhausted callback'),
      );
    }
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
