/**
 * Consecutive-download-failure alert (follow-up to the 2026-07-31 flagged-jar
 * incident).
 *
 * The bot-detection machinery only recognises explicit bot-check signatures
 * ("Sign in to confirm…"), so a failure mode like the flagged guest cookie
 * jar — every download dying mid-transfer with a plain HTTP 403 — tripped
 * nothing and ran silently for 8 days. This detector is signature-blind on
 * purpose: it counts consecutive TERMINAL download failures (attempts
 * exhausted), whatever the error, and sends Steve exactly one ntfy alert per
 * streak once the count crosses the threshold. A successful download ends the
 * streak and re-arms the alert.
 *
 * Deliberately alert-only: no queue pause, no automated jar rotation. Pausing
 * on unrecognised failures is the circuit breaker's call (bot signatures
 * only, ADR-0012), and rotation stays a manual runbook step (docs/ops.md,
 * "Rotate") — one aged spare jar on the shelf makes recovery a one-liner.
 *
 * Cross-process safe the same way the circuit breaker is: counter and
 * alert-claim live in Redis, so restarts don't reset a streak and only one
 * process can win the SET NX claim. Cooldown parks (DelayedError) never reach
 * the worker's 'failed' handler, so bot-detection blocks don't double-count
 * here.
 */
import { redis } from './queue';
import { getNotifications } from './modules/notifications';
import { config } from './config';
import { logger } from './logger';

// Running count of consecutive terminal download failures. Cleared on any
// successful download.
export const FAILURE_STREAK_KEY = 'eddy:downloads:failure-streak';

// Single-alert claim for the current streak (SET NX, no expiry). Cleared on
// any successful download, so the next streak can alert again.
export const FAILURE_STREAK_ALERTED_KEY = 'eddy:downloads:failure-streak-alerted';

// Pure decision: does this streak length warrant the alert? `>=` (not `===`)
// so a lost claim-race or a failed send can still be retried by later
// failures in the same streak — the SET NX claim, not this predicate, is
// what dedupes.
export function shouldAlertOnStreak(count: number, threshold: number): boolean {
  return count >= threshold;
}

// Seam for tests — production wiring closes over Redis and ntfy.
export interface FailureStreakDeps {
  // Increment the streak counter, returning the new count.
  incrementStreak: () => Promise<number>;
  // Clear the counter and the alert claim (a success ends the streak).
  clearStreak: () => Promise<void>;
  // Claim the single-alert slot. True iff this call newly claimed it.
  claimAlert: () => Promise<boolean>;
  // Release the slot after a failed send so a later failure retries the alert.
  releaseAlert: () => Promise<void>;
  // Send the one ntfy alert to Steve's adult topic.
  sendAlert: (consecutiveFailures: number, lastError: string) => Promise<void>;
}

const defaultDeps: FailureStreakDeps = {
  incrementStreak: async () => redis.incr(FAILURE_STREAK_KEY),
  clearStreak: async () => {
    await redis.del(FAILURE_STREAK_KEY, FAILURE_STREAK_ALERTED_KEY);
  },
  claimAlert: async () => {
    const res = await redis.set(FAILURE_STREAK_ALERTED_KEY, new Date().toISOString(), 'NX');
    return res === 'OK';
  },
  releaseAlert: async () => {
    await redis.del(FAILURE_STREAK_ALERTED_KEY);
  },
  sendAlert: async (consecutiveFailures, lastError) => {
    await getNotifications().notify(
      { kind: 'download_failure_streak', consecutiveFailures, lastError },
      config.USER_ID_STEVE,
    );
  },
};

// First line of the error, capped — enough to recognise the signature (e.g.
// "HTTP Error 403: Forbidden") without dumping a stack trace into ntfy. No
// titles or user attribution: the alert describes pipeline health, not
// anyone's viewing.
export function summariseError(message: string): string {
  const firstLine = message.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.slice(0, 200);
}

// Record one terminal download failure. Alerts (once per streak) when the
// consecutive count reaches the threshold. Fail-open: a dead Redis/ntfy must
// not wedge the worker's failure handling.
export async function recordDownloadFailure(
  errorMessage: string,
  deps: FailureStreakDeps = defaultDeps,
): Promise<boolean> {
  try {
    const count = await deps.incrementStreak();
    if (!shouldAlertOnStreak(count, config.DOWNLOAD_FAILURE_STREAK_THRESHOLD)) return false;
    const claimed = await deps.claimAlert();
    if (!claimed) return false;
    try {
      await deps.sendAlert(count, summariseError(errorMessage));
    } catch (err) {
      // A failed send must not burn the streak's only alert — give back the
      // claim so the next failure retries the notification.
      await deps.releaseAlert();
      throw err;
    }
    logger.warn(
      { consecutiveFailures: count, threshold: config.DOWNLOAD_FAILURE_STREAK_THRESHOLD },
      'Download failure streak threshold reached — alert sent',
    );
    return true;
  } catch (err) {
    logger.warn({ err }, 'Failure-streak recording encountered an error (fail-open)');
    return false;
  }
}

// Record a successful download: ends any streak and re-arms the alert.
// Fail-open.
export async function recordDownloadSuccess(
  deps: FailureStreakDeps = defaultDeps,
): Promise<void> {
  try {
    await deps.clearStreak();
  } catch (err) {
    logger.warn({ err }, 'Failure-streak reset encountered an error (fail-open)');
  }
}
