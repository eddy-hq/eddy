// What a parent's Allow / Block does to a kid's candidate_pool row (Phase 6a).
// Allow makes it eligible for the slate exactly as a guard clear_yes would
// (status 'scored', guard_verdict 'clear_yes' — the kid surface filters on
// both). Block takes it out as a guard clear_no would. A candidate already
// picked ('requested') has become a request; the caller acts on that instead.
import { db } from '../../db/client';

export type CandidateParentOutcome =
  | { applied: true; status: 'scored' | 'guard_rejected' }
  | { applied: false; status: string | null };

// Statuses each verdict may move a candidate out of. 'dismissed' and
// 'requested' are left alone: the first is the kid's own call, the second is
// now a request.
const ALLOW_FROM = ['guard_pending', 'guard_rejected', 'scored'];
const BLOCK_FROM = ['guard_pending', 'scored', 'surfaced'];

export function applyCandidateParentVerdict(
  candidateId: string,
  verdict: 'clear_yes' | 'clear_no',
): CandidateParentOutcome {
  const from = verdict === 'clear_yes' ? ALLOW_FROM : BLOCK_FROM;
  const status = verdict === 'clear_yes' ? 'scored' : 'guard_rejected';
  const placeholders = from.map(() => '?').join(', ');
  const res = db.prepare(
    `UPDATE candidate_pool SET status = ?, guard_verdict = ?
      WHERE candidate_id = ? AND status IN (${placeholders})`,
  ).run(status, verdict, candidateId, ...from);
  if (res.changes > 0) return { applied: true, status };
  const row = db.prepare('SELECT status FROM candidate_pool WHERE candidate_id = ?')
    .get(candidateId) as { status: string } | undefined;
  return { applied: false, status: row?.status ?? null };
}
