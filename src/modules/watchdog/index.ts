import { db } from '../../db/client';
import { logger } from '../../logger';
import { downloadQueue } from '../../queue';
import { getNotifications } from '../notifications';
import { config } from '../../config';
import type { DownloadJobData } from '../content';
import { getRequestsState } from '../requests';

const MIN_AGE_MS = 2 * 60 * 1000; // ignore requests younger than 2 min (callback may still be in-flight)
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Re-enqueue limit per request before the watchdog gives up and escalates to
// `failed`. At CHECK_INTERVAL_MS=5min × threshold=3 this is a ~15-minute grace
// window during which an underlying bug (e.g. a stale yt-dlp intermediate
// triggering HTTP 416 on every resume) can be ridden out, before we stop
// silently spinning at default priority and surface the failure loudly.
const REENQUEUE_ESCALATION_THRESHOLD = 3;

// Per-request count of consecutive re-enqueues with no progress out of
// `downloading`. Reset when the row leaves `downloading` (resolved, rejected,
// failed, etc.). In-memory only — a server restart resets the grace window,
// which is the right behaviour (a fresh process gets a fresh chance).
const consecutiveReenqueues = new Map<string, number>();

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

  // Drop counters for requests that have left `downloading` since the last
  // cycle. Done before the empty-result early return so a successful
  // download still clears its prior count.
  const stillStuck = new Set(downloading.map((r) => r.request_id));
  for (const id of [...consecutiveReenqueues.keys()]) {
    if (!stillStuck.has(id)) consecutiveReenqueues.delete(id);
  }

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

    // Escalate before re-enqueueing if we've already retried this request the
    // threshold number of times without it making progress. Stops the
    // re-enqueue/fail/re-enqueue loop a buggy worker can otherwise sustain
    // indefinitely at default-priority notifications.
    const priorReenqueues = consecutiveReenqueues.get(req.request_id) ?? 0;
    if (priorReenqueues >= REENQUEUE_ESCALATION_THRESHOLD) {
      log.warn({ priorReenqueues }, 'Re-enqueue threshold exceeded — marking failed');
      const { result } = getRequestsState().apply({
        kind: 'mark_failed',
        requestId: req.request_id,
      });
      consecutiveReenqueues.delete(req.request_id);
      if (!result.transitioned) {
        log.warn({ currentStatus: result.currentStatus }, 'Escalation no-op — row already changed state');
        continue;
      }
      void getNotifications().notify(
        {
          kind: 'download_alert',
          requestId: req.request_id,
          title: req.title ?? req.youtube_id ?? req.url,
          stuckMins: Math.round((Date.now() - new Date(req.requested_at).getTime()) / 60_000),
          action: 'failed',
        },
        config.USER_ID_STEVE,
      );
      continue;
    }

    // Job is failed, unknown, missing, or in an unexpected state — re-enqueue.
    const jobData: DownloadJobData = {
      requestId: req.request_id,
      youtubeId: req.youtube_id ?? '',
      url: req.url,
    };

    let reenqueued = false;
    try {
      // Remove the old job first (if it exists in a terminal state)
      if (jobState !== null) {
        const job = await downloadQueue.getJob(req.request_id);
        await job?.remove();
      }
      await downloadQueue.add('download', jobData, { jobId: req.request_id });
      reenqueued = true;
      consecutiveReenqueues.set(req.request_id, priorReenqueues + 1);
      log.info({ jobState, priorReenqueues: priorReenqueues + 1 }, 'Re-enqueued stuck download');
    } catch (err) {
      log.error({ err }, 'Failed to re-enqueue stuck download — marking failed');
      const { result } = getRequestsState().apply({
        kind: 'mark_failed',
        requestId: req.request_id,
      });
      consecutiveReenqueues.delete(req.request_id);
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

    void getNotifications().notify(
      {
        kind: 'download_alert',
        requestId: req.request_id,
        title: req.title ?? req.youtube_id ?? req.url,
        stuckMins: Math.round((Date.now() - new Date(req.requested_at).getTime()) / 60_000),
        action: reenqueued ? 're-enqueued' : 'failed',
      },
      config.USER_ID_STEVE,
    );
  }
}

// Test seam: reset in-memory counters between cases.
export function resetWatchdogStateForTests(): void {
  consecutiveReenqueues.clear();
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
