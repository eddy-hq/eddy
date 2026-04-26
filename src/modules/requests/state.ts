import { db } from '../../db/client';
import { logger } from '../../logger';
import { downloadQueue, redis } from '../../queue';

export type Status =
  | 'pending'
  | 'downloading'
  | 'guard_review'
  | 'parent_review'
  | 'approved'
  | 'ready'
  | 'rejected'
  | 'failed'
  | 'watched'
  | 'dismissed'
  | 'deleted';

// Stable sentinel stored in `rejection_reason` when a user cancels their own
// download — distinct from freeform reasons set by the guard / parent review.
export const CANCELLED_REASON = '__cancelled_by_user';

// currentStatus is `string` (not `Status`) because the DB can hold statuses
// outside this module's machine-recognized set until later slices broaden it.
export type TransitionResult =
  | { transitioned: true; userId: string }
  | { transitioned: false; currentStatus: string | null };

// Allow-list: source status → permitted destination statuses.
// Subsequent slices fill in entries as they migrate transitions into this module.
export const LEGAL: Record<Status, Status[]> = {
  pending: ['dismissed', 'rejected'],
  downloading: ['rejected'],
  guard_review: ['rejected'],
  parent_review: ['rejected'],
  approved: ['dismissed', 'rejected'],
  ready: ['watched', 'dismissed'],
  rejected: ['dismissed'],
  failed: ['dismissed'],
  watched: ['dismissed'],
  dismissed: [],
  deleted: ['dismissed'],
};

function legalSourcesFor(target: Status): Status[] {
  return (Object.keys(LEGAL) as Status[]).filter((s) => LEGAL[s].includes(target));
}

function readStatus(id: string): string | null {
  const row = db.prepare(`SELECT status FROM requests WHERE request_id = ?`).get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

// Render a stored `rejection_reason` for kid-facing surfaces. Sentinels become
// human-readable; freeform reasons pass through unchanged.
export function displayRejectionReason(reason: string | null): string | null {
  if (reason === CANCELLED_REASON) return 'Cancelled';
  return reason;
}

export function markWatched(id: string): TransitionResult {
  const sources = legalSourcesFor('watched');
  const placeholders = sources.map(() => '?').join(', ');
  const now = new Date().toISOString();

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'watched', watched_at = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(now, id, ...sources) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

export function markDismissed(id: string): TransitionResult {
  const sources = legalSourcesFor('dismissed');
  const placeholders = sources.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'dismissed'
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(id, ...sources) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

export function markCancelled(id: string): TransitionResult {
  const sources = legalSourcesFor('rejected');
  const placeholders = sources.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'rejected', rejection_reason = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(CANCELLED_REASON, id, ...sources) as { user_id: string } | undefined;

  if (!updated) return { transitioned: false, currentStatus: readStatus(id) };

  // Side-effects fire only after a real transition — no-ops do not touch Redis
  // or BullMQ. Both are best-effort: a missing job or unreachable Redis must
  // not roll back the cancel.
  void downloadQueue
    .getJob(id)
    .then((job) => job?.remove())
    .catch((err) => logger.warn({ err, requestId: id }, 'Cancel: failed to remove BullMQ job'));
  void redis
    .del(`eddy:progress:${id}`)
    .catch((err) => logger.warn({ err, requestId: id }, 'Cancel: failed to delete progress key'));

  return { transitioned: true, userId: updated.user_id };
}
