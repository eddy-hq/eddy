import { db } from '../../db/client';
import { logger } from '../../logger';
import { downloadQueue } from '../../queue';
import { sendDownloadAlert } from '../notifications';
import type { DownloadJobData } from '../content';
import { getRequestsState } from '../requests';

const MIN_AGE_MS = 2 * 60 * 1000; // ignore requests younger than 2 min (callback may still be in-flight)
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface StuckRequest {
  request_id: string;
  youtube_id: string | null;
  url: string;
  user_id: string;
  title: string | null;
  requested_at: string;
}

export async function checkStuckDownloads(): Promise<void> {
  const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();

  const downloading = db.prepare(`
    SELECT request_id, youtube_id, url, user_id, title, requested_at
    FROM requests
    WHERE status = 'downloading'
      AND requested_at < ?
  `).all(cutoff) as StuckRequest[];

  if (downloading.length === 0) return;

  for (const req of downloading) {
    const log = logger.child({ requestId: req.request_id, youtubeId: req.youtube_id });

    let jobState: string | null = null;
    try {
      const job = await downloadQueue.getJob(req.request_id);
      jobState = job ? await job.getState() : null;
    } catch (err) {
      log.warn({ err }, 'Could not check BullMQ job state');
      continue; // Redis unavailable — skip rather than false-positive
    }

    // Job is active or delayed — legitimately in-flight. `active` is a real
    // download in progress (possibly a long video); `delayed` is the worker
    // having parked a job for a future retry (e.g. live broadcast waiting on
    // its VOD). Either way: leave it alone.
    if (jobState === 'active' || jobState === 'delayed') continue;

    // Job is failed, unknown, missing, or in an unexpected state — re-enqueue.
    const jobData: DownloadJobData = {
      requestId: req.request_id,
      youtubeId: req.youtube_id ?? '',
      url: req.url,
    };

    try {
      // Remove the old job first (if it exists in a terminal state)
      if (jobState !== null) {
        const job = await downloadQueue.getJob(req.request_id);
        await job?.remove();
      }
      await downloadQueue.add('download', jobData, { jobId: req.request_id });
      log.info({ jobState }, 'Re-enqueued stuck download');
    } catch (err) {
      log.error({ err }, 'Failed to re-enqueue stuck download — marking failed');
      const { result } = getRequestsState().apply({
        kind: 'mark_failed',
        requestId: req.request_id,
      });
      if (!result.transitioned) {
        // Row changed state between the SELECT and this catch (e.g. a worker
        // callback landed concurrently). Whatever owns the new state owns the
        // user-facing outcome — don't double-alert with stale "failed" wording.
        log.warn(
          { currentStatus: result.currentStatus },
          'Watchdog mark_failed no-op — row already changed state, skipping alert',
        );
        continue;
      }
    }

    void sendDownloadAlert({
      requestId: req.request_id,
      title: req.title ?? req.youtube_id ?? req.url,
      stuckMins: Math.round((Date.now() - new Date(req.requested_at).getTime()) / 60_000),
      action: jobState === null || jobState === 'failed' ? 're-enqueued' : 'failed',
    });
  }
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function startWatchdog(): void {
  if (watchdogTimer) return;
  logger.info({ intervalMins: 5 }, 'Download watchdog started');
  watchdogTimer = setInterval(() => {
    void checkStuckDownloads().catch((err: unknown) => {
      logger.error({ err }, 'Watchdog check failed');
    });
  }, CHECK_INTERVAL_MS);
  // Run once shortly after startup to catch anything that was stuck before restart
  setTimeout(() => {
    void checkStuckDownloads().catch((err: unknown) => {
      logger.error({ err }, 'Watchdog startup check failed');
    });
  }, 30_000);
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
