import { db } from '../../db/client';

export type Status =
  | 'downloading'
  | 'ready'
  | 'rejected'
  | 'failed'
  | 'watched'
  | 'dismissed'
  | 'deleted';

// currentStatus is `string` (not `Status`) because the DB can hold statuses
// outside this module's machine-recognized set (e.g. `pending`, `guard_review`)
// until later slices broaden the union.
export type TransitionResult =
  | { transitioned: true; userId: string }
  | { transitioned: false; currentStatus: string | null };

// Allow-list: source status → permitted destination statuses.
// Subsequent slices fill in entries as they migrate transitions into this module.
export const LEGAL: Record<Status, Status[]> = {
  downloading: [],
  ready: ['watched'],
  rejected: [],
  failed: [],
  watched: [],
  dismissed: [],
  deleted: [],
};

function legalSourcesFor(target: Status): Status[] {
  return (Object.keys(LEGAL) as Status[]).filter((s) => LEGAL[s].includes(target));
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

  const row = db
    .prepare(`SELECT status FROM requests WHERE request_id = ?`)
    .get(id) as { status: string } | undefined;
  return { transitioned: false, currentStatus: row?.status ?? null };
}
