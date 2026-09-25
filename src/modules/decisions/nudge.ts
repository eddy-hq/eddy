// The daily Decisions nudge (Phase 6a): one "N decisions waiting" notification
// to each parent when Today's queue is non-empty, at most once a day. Opaque
// per ADR-0013: the push carries a message id only, and the stored message
// says how many cards wait and links to /decisions — no titles, channels or
// kid names.
import { Worker } from 'bullmq';
import { config } from '../../config';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { decisionsQueue, redis } from '../../queue';
import { getNotifications } from '../notifications';
import { listParentIds } from '../users';
import { readDecisionQueue } from './queue';

// No colons (BullMQ custom ids take 0 or exactly 2).
export const DECISIONS_NUDGE_JOB_ID = 'decisions-nudge';
const NUDGE_JOB_NAME = 'nudge';

// Cards a parent would see in Today right now: the same read the queue
// endpoint serves, so the number matches what the tap opens.
export function countDecisionsWaiting(now: Date = new Date()): number {
  return readDecisionQueue({ mode: 'today', now }).cards.length;
}

// The calendar day of `now` in the nudge's time zone, as YYYY-MM-DD.
export function nudgeDay(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export interface NudgeResult {
  count: number;
  // Parents notified by this call (empty when nothing waits or all were
  // already nudged today).
  notified: string[];
}

// Claim the day's nudge for a parent. False when one was already sent.
function claimNudge(day: string, userId: string, count: number, now: Date): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO decision_nudges (day, user_id, count, sent_at) VALUES (?, ?, ?, ?)
  `).run(day, userId, count, now.toISOString()).changes === 1;
}

export async function sendDecisionsNudge(
  now: Date = new Date(),
  timeZone: string = config.DECISIONS_NUDGE_TZ,
): Promise<NudgeResult> {
  const count = countDecisionsWaiting(now);
  if (count === 0) {
    logger.info({ count }, 'Decisions nudge: nothing waiting, not sent');
    return { count, notified: [] };
  }

  const day = nudgeDay(now, timeZone);
  const notified: string[] = [];
  for (const parentId of listParentIds()) {
    if (!claimNudge(day, parentId, count, now)) continue;
    // notify() never throws: a delivery failure is logged there.
    await getNotifications().notify({ kind: 'decisions_waiting', count }, parentId);
    notified.push(parentId);
  }
  logger.info({ count, day, notified: notified.length }, 'Decisions nudge sent');
  return { count, notified };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
//
// A BullMQ job scheduler on the M4, upserted on every boot so a changed
// DECISIONS_NUDGE_CRON / _TZ replaces the old schedule rather than adding a
// second one.

let nudgeWorker: Worker | null = null;

export function startDecisionsNudgeScheduler(): void {
  const pattern = config.DECISIONS_NUDGE_CRON;
  const tz = config.DECISIONS_NUDGE_TZ;
  void decisionsQueue.upsertJobScheduler(
    DECISIONS_NUDGE_JOB_ID,
    { pattern, tz },
    { name: NUDGE_JOB_NAME, data: {} },
  ).catch((err: unknown) => logger.warn({ err }, 'Decisions nudge: failed to schedule'));

  nudgeWorker = new Worker('decisions', async (job) => {
    if (job.name === NUDGE_JOB_NAME) await sendDecisionsNudge();
  }, { connection: redis, concurrency: 1 });

  nudgeWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Decisions nudge job failed');
  });

  logger.info({ pattern, tz }, 'Decisions nudge scheduler started');
}

export async function stopDecisionsNudgeScheduler(): Promise<void> {
  if (nudgeWorker) {
    await nudgeWorker.close();
    nudgeWorker = null;
  }
}
