import { db } from '../../db/client';
import { logger } from '../../logger';
import { downloadQueue } from '../../queue';
import { getNotifications } from '../notifications';
import { config } from '../../config';
import type { DownloadJobData } from '../content';
import { getRequestsState } from '../requests';

const MIN_AGE_MS = 2 * 60 * 1000; // ignore requests younger than 2 min (callback may still be in-flight)
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Grace window before the watchdog gives up on a stuck `downloading` row and
// escalates it to `failed`. A row younger than this gets re-enqueued each cycle
// (recovering a job that vanished from Redis); once it crosses the window the
// watchdog stops re-enqueueing and surfaces the failure loudly instead.
//
// #184: this used to be a count of re-enqueues (threshold 3 × 5-min cycle ≈ the
// same 15 min), held in an in-memory Map. The M4 server runs as `tsx watch`
// under launchd and restarts often; each restart wiped the counter, so the
// give-up window never completed and stuck rows re-enqueued every 5 min
// forever — sustaining pressure on a rate-blocked YouTube IP. Measuring elapsed
// time against the row's stored `requested_at` is restart-proof by
// construction: the verdict is the same no matter how many times the process
// has bounced.
const ESCALATION_AGE_MS = 15 * 60 * 1000;

// Pure escalation predicate (the heart of the #184 fix). Whether a stuck
// `downloading` row has been alive long enough to give up on. Decided solely
// from the stored `requested_at` against the supplied clock — no process-local
// state — so it survives any number of restarts and is trivially unit-testable.
//
// A non-finite age (unparseable timestamp — shouldn't happen, `requested_at` is
// NOT NULL and machine-written) escalates rather than loops: "fail loudly"
// beats the silent forever-spin this issue is about.
//
// Caveat (deliberate): `requested_at` is the original request time, not the
// start of the current downloading spell, so an admin `retry` of an ancient row
// inherits a stale clock and can escalate on its first failed cycle without the
// usual re-enqueue attempts. That's acceptable — retry enqueues a fresh job
// that stays healthy-pending (and is skipped) until it genuinely fails, and an
// old row that fails again is a fair thing to surface immediately.
export function isStuckBeyondGrace(requestedAt: string, nowMs: number): boolean {
  const stuckMs = nowMs - Date.parse(requestedAt);
  return !Number.isFinite(stuckMs) || stuckMs >= ESCALATION_AGE_MS;
}

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

  const now = Date.now();

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

    // Healthy-pending BullMQ states — leave alone.
    //   active            — a real download in progress (possibly a long video)
    //   delayed           — worker parked the job for a future retry (e.g.
    //                       live broadcast waiting on its VOD)
    //   waiting           — queued, not yet picked up (worker backlogged or down)
    //   waiting-children  — waiting on child jobs (unused here, defensive)
    //   prioritized       — queued in priority lane (unused here, defensive)
    //   paused            — queue paused by an operator
    //
    // The escalation path mustn't touch these regardless of age: a worker
    // outage that lasts >15 minutes would otherwise transition every queued
    // download to `failed` while a valid job is still sitting in the queue.
    // When the worker returns, it would complete the download but the
    // `mark_downloaded` callback would no-op against a `failed` row, leaving
    // an orphan file on disk.
    if (
      jobState === 'active' ||
      jobState === 'delayed' ||
      jobState === 'waiting' ||
      jobState === 'waiting-children' ||
      jobState === 'prioritized' ||
      jobState === 'paused'
    ) continue;

    const stuckMins = Math.round((now - new Date(req.requested_at).getTime()) / 60_000);

    // Escalate before re-enqueueing once the row has been stuck past the grace
    // window. Stops the re-enqueue/fail/re-enqueue loop a buggy worker (or a
    // rate-blocked IP) can otherwise sustain indefinitely, and surfaces the
    // failure loudly. Restart-proof: the verdict reads only from `requested_at`.
    if (isStuckBeyondGrace(req.requested_at, now)) {
      log.warn({ stuckMins }, 'Stuck beyond grace window — marking failed');
      const { result } = getRequestsState().apply({
        kind: 'mark_failed',
        requestId: req.request_id,
      });
      if (!result.transitioned) {
        log.warn({ currentStatus: result.currentStatus }, 'Escalation no-op — row already changed state');
        continue;
      }
      void getNotifications().notify(
        {
          kind: 'download_alert',
          requestId: req.request_id,
          title: req.title ?? req.youtube_id ?? req.url,
          stuckMins,
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
      log.info({ jobState, stuckMins }, 'Re-enqueued stuck download');
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

    void getNotifications().notify(
      {
        kind: 'download_alert',
        requestId: req.request_id,
        title: req.title ?? req.youtube_id ?? req.url,
        stuckMins,
        action: reenqueued ? 're-enqueued' : 'failed',
      },
      config.USER_ID_STEVE,
    );
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
