import fs from 'fs';
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
  ready: ['watched', 'dismissed', 'deleted'],
  rejected: ['dismissed'],
  failed: ['dismissed'],
  watched: ['dismissed', 'deleted'],
  dismissed: [],
  deleted: ['dismissed'],
};

function legalSourcesFor(target: Status): Status[] {
  return (Object.keys(LEGAL) as Status[]).filter((s) => LEGAL[s].includes(target));
}

// Cancel is bound to user intent and must stay independent of other transitions
// that may also write `rejected` (e.g. guard verdicts). Declared explicitly
// rather than derived from LEGAL so a future non-cancel rejection path can't
// silently broaden cancel eligibility — or, worse, overwrite a guard-set
// rejection_reason with the cancel sentinel.
const CANCELLABLE_FROM: Status[] = [
  'pending',
  'downloading',
  'guard_review',
  'parent_review',
  'approved',
];

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

// Best-effort: a missing or unlinkable file must not roll back the soft-delete.
async function unlinkVideoAndSidecars(filePath: string, requestId: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
    const base = filePath.replace(/\.[^.]+$/, '');
    for (const ext of ['.en.vtt', '.en.srt', '.vtt', '.srt']) {
      await fs.promises.unlink(base + ext).catch(() => { /* sidecar may not exist */ });
    }
    logger.info({ requestId }, 'Video file deleted');
  } catch (err) {
    logger.warn({ err, requestId }, 'Could not delete video file — record still marked deleted');
  }
}

export function markSoftDeleted(id: string): TransitionResult {
  const sources = legalSourcesFor('deleted');
  const placeholders = sources.map(() => '?').join(', ');
  const now = new Date().toISOString();

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'deleted', file_state = 'gone', deleted_at = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id, file_path`,
    )
    .get(now, id, ...sources) as { user_id: string; file_path: string | null } | undefined;

  if (!updated) return { transitioned: false, currentStatus: readStatus(id) };

  // Side-effects fire only after a real transition. Filesystem failures are
  // logged-warned, not thrown — the row stays `deleted` even if the file is
  // already gone or unlinkable.
  if (updated.file_path) {
    void unlinkVideoAndSidecars(updated.file_path, id);
  }

  return { transitioned: true, userId: updated.user_id };
}

export function markCancelled(id: string): TransitionResult {
  const placeholders = CANCELLABLE_FROM.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'rejected', rejection_reason = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(CANCELLED_REASON, id, ...CANCELLABLE_FROM) as { user_id: string } | undefined;

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
