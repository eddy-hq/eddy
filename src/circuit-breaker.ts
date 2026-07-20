/**
 * yt-dlp circuit breaker (ADR-0012, change B).
 *
 * The escalating cooldown in `botdetect.ts` backs off harder on each consecutive
 * block, but past a run of blocks every automated probe has negative expected
 * value — it can only refresh the flag (ADR-0012 §3). So after a fixed number of
 * consecutive bot-detection re-trips we stop probing entirely: pause BOTH
 * yt-dlp-touching queues (the same lever `pipeline-pause.ts` pulls), alert Steve
 * once, and wait for a manual resume. Dark-until-manual, by design.
 *
 * This module owns the queue + ntfy coupling deliberately, keeping `botdetect.ts`
 * a pure detector + thin Redis wrappers. The detector returns the running strike
 * `level`; this decides whether that level warrants tripping.
 *
 * Cross-process: the detector arms on BOTH the M4 (discovery/intake) and the
 * Ubuntu worker (download). Both import `queue.ts` (BullMQ `pause()` writes a
 * global Redis meta key, so a pause from either host stops workers everywhere)
 * and both can reach `getNotifications()`. The single-alert guarantee is a Redis
 * `SET NX` flag: whichever process wins the flag sends the one alert; re-trips
 * from either process find the flag already set and stay quiet.
 */
import { discoveryQueue, downloadQueue, redis } from './queue';
import { getNotifications } from './modules/notifications';
import { config } from './config';
import { logger } from './logger';
import { BOT_DETECTION_COOLDOWN_KEY, BOT_DETECTION_LEVEL_KEY } from './botdetect';

// Idempotency flag: set (SET NX, no expiry) when the breaker opens so only one
// process alerts and re-trips don't re-alert. Cleared only by a manual resume
// (resetCircuitBreaker), so the pipeline stays dark until a human intervenes.
export const CIRCUIT_OPEN_KEY = 'eddy:ytdlp:circuit-open';

// Consecutive bot-detection re-trips before the pipeline goes dark (ADR-0012).
// A constant, not an env var — the ADR fixes it at 3.
export const CIRCUIT_BREAKER_THRESHOLD = 3;

// Pure decision: does this escalation level warrant tripping the breaker? The
// detector's `level` climbs by one on each consecutive strike (and keeps
// climbing past the cooldown ladder's cap), so `>=` holds for every trip once
// the threshold is reached — the SET NX flag, not this predicate, dedupes alerts.
export function shouldTripCircuit(level: number): boolean {
  return level >= CIRCUIT_BREAKER_THRESHOLD;
}

// Seam for tests — production wiring closes over queues, Redis and ntfy.
export interface CircuitBreakerDeps {
  // Pause both yt-dlp-touching queues. Idempotent.
  pauseQueues: () => Promise<void>;
  // Claim the single-alert slot. Returns true iff this call newly opened the
  // circuit (SET NX succeeded), so exactly one caller across both processes
  // sends the alert.
  claimAlert: () => Promise<boolean>;
  // Send the one ntfy alert to Steve's adult topic.
  sendAlert: (consecutiveTrips: number) => Promise<void>;
}

const defaultDeps: CircuitBreakerDeps = {
  pauseQueues: async () => {
    await discoveryQueue.pause();
    await downloadQueue.pause();
  },
  claimAlert: async () => {
    const res = await redis.set(CIRCUIT_OPEN_KEY, new Date().toISOString(), 'NX');
    return res === 'OK';
  },
  sendAlert: async (consecutiveTrips) => {
    await getNotifications().notify(
      { kind: 'circuit_open', consecutiveTrips },
      config.USER_ID_STEVE,
    );
  },
};

// Trip the breaker when the strike level has reached the threshold. Pauses the
// queues on every trip (idempotent) but alerts + logs only on the transition
// (whichever process wins the SET NX). Returns whether this call opened the
// circuit (i.e. sent the alert). Fail-open: never throws into the caller's
// error path — a dead Redis/ntfy must not wedge the arming site.
export async function tripCircuitIfNeeded(
  level: number,
  deps: CircuitBreakerDeps = defaultDeps,
): Promise<boolean> {
  if (!shouldTripCircuit(level)) return false;
  try {
    await deps.pauseQueues();
    const opened = await deps.claimAlert();
    if (opened) {
      await deps.sendAlert(level);
      logger.warn(
        { consecutiveTrips: level, threshold: CIRCUIT_BREAKER_THRESHOLD },
        'yt-dlp circuit breaker OPEN — paused discovery+download queues after consecutive bot-detection trips; manual resume required',
      );
    }
    return opened;
  } catch (err) {
    logger.warn({ err }, 'Circuit breaker trip encountered an error (fail-open)');
    return false;
  }
}

// Clear all breaker + escalation state on a manual resume: the open flag, the
// strike counter and any active cooldown. Without this, the next arm after a
// resume would inherit stale strikes and re-escalate (or re-trip) instantly.
// Hooked into `pipeline-pause.ts`'s resume helper so every manual resume path
// clears it. Fail-open.
export async function resetCircuitBreaker(): Promise<void> {
  try {
    await redis.del(CIRCUIT_OPEN_KEY, BOT_DETECTION_LEVEL_KEY, BOT_DETECTION_COOLDOWN_KEY);
  } catch (err) {
    logger.warn({ err }, 'Could not reset circuit breaker state (Redis unavailable)');
  }
}
