// Recording a parent's decision (Phase 6a): the label goes to guard_decisions
// (and onto the guard_eval row shown, when unambiguous), and the decision acts
// on the kid's feed through the module that owns the row.
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { logger } from '../../logger';
import { applyCandidateParentVerdict } from '../discovery';
import {
  RUBRIC_VERSION,
  labelGuardEval,
  shownEvalForCandidate,
  shownEvalForRequest,
  type ShownEval,
} from '../guard';
import { SLATE_PICK_SOURCES, findSlatePickRequest, getRequestsState } from '../requests';
import { getAgeBand, resolveUserById } from '../users';
import {
  PARENT_BLOCKED_REASON,
  type DecisionSource,
  type HumanVerdict,
  type SubjectType,
} from './util';

export interface DecisionInput {
  subjectType: SubjectType;
  subjectId: string;
  verdict: HumanVerdict;
}

// What the decision did to the kid's feed.
//   eligible   candidate can now be picked for the slate
//   blocked    candidate taken out of the pool
//   shown      parked request now visible
//   removed    request taken off the feed, file removed
//   label_only nothing to change (shadow-mode request, already picked, or
//              the row moved on since the queue was read)
export type DecisionEffect = 'eligible' | 'blocked' | 'shown' | 'removed' | 'label_only';

export interface DecisionOutcome {
  subjectType: SubjectType;
  subjectId: string;
  source: DecisionSource;
  effect: DecisionEffect;
  alreadyDecided: boolean;
  // Revealed after the answer, for Spot checks.
  guard: ShownEval;
}

interface Subject {
  subjectType: SubjectType;
  subjectId: string;
  userId: string;
  url: string;
  youtubeId: string | null;
  status: string;
  guardVerdict: string | null;
  requestSource: string | null;
}

export function requireParent(userId: unknown): string {
  const user = resolveUserById(userId);
  if (user.role !== 'parent') throw new ForbiddenError('Decisions are for parents only');
  return user.user_id;
}

function readSubject(type: SubjectType, id: string): Subject {
  const row = type === 'candidate'
    ? db.prepare(`
        SELECT cp.user_id, cp.url, cp.external_id AS youtube_id, cp.status, cp.guard_verdict,
               NULL AS request_source, u.role
          FROM candidate_pool cp JOIN users u ON u.user_id = cp.user_id
         WHERE cp.candidate_id = ?`).get(id)
    : db.prepare(`
        SELECT r.user_id, r.url, r.youtube_id, r.status, r.guard_verdict,
               r.source AS request_source, u.role
          FROM requests r JOIN users u ON u.user_id = r.user_id
         WHERE r.request_id = ?`).get(id);
  const r = row as {
    user_id: string; url: string; youtube_id: string | null; status: string;
    guard_verdict: string | null; request_source: string | null; role: string;
  } | undefined;
  if (!r || r.role !== 'kid') throw new NotFoundError(`${type} ${id}`);
  return {
    subjectType: type,
    subjectId: id,
    userId: r.user_id,
    url: r.url,
    youtubeId: r.youtube_id,
    status: r.status,
    guardVerdict: r.guard_verdict,
    requestSource: r.request_source,
  };
}

// A parked subject is an Escalation; anything else must have been drawn as a
// Spot check. Anything outside the queue can't be decided here.
function sourceFor(s: Subject): DecisionSource {
  if (s.status === 'guard_pending') return 'escalation';
  const drawn = db.prepare(`
    SELECT source FROM guard_spot_checks
     WHERE subject_type = ? AND subject_id = ?
     ORDER BY day DESC LIMIT 1
  `).get(s.subjectType, s.subjectId) as { source: DecisionSource } | undefined;
  if (!drawn) throw new ValidationError(`${s.subjectType} ${s.subjectId} is not in the Decisions queue`);
  return drawn.source;
}

async function blockRequest(requestId: string, parentId: string): Promise<boolean> {
  const { result, settled } = getRequestsState().apply({
    kind: 'mark_parent_blocked', requestId, parentId, reason: PARENT_BLOCKED_REASON,
  });
  await settled;
  return result.transitioned;
}

async function applyEffect(s: Subject, verdict: HumanVerdict, parentId: string): Promise<DecisionEffect> {
  if (s.subjectType === 'candidate') {
    if (s.status === 'requested') {
      // Picked already: the kid's copy is a request. Block acts on it; allow
      // has nothing to change.
      if (verdict === 'clear_yes' || !s.youtubeId) return 'label_only';
      const req = findSlatePickRequest(s.userId, s.youtubeId);
      if (!req) return 'label_only';
      return (await blockRequest(req.requestId, parentId)) ? 'removed' : 'label_only';
    }
    const out = applyCandidateParentVerdict(s.subjectId, verdict);
    if (!out.applied) return 'label_only';
    return out.status === 'scored' ? 'eligible' : 'blocked';
  }

  if (s.status === 'guard_pending') {
    if (verdict === 'clear_yes') {
      const { result, settled } = getRequestsState().apply({
        kind: 'mark_parent_allowed', requestId: s.subjectId, parentId,
      });
      await settled;
      return result.transitioned ? 'shown' : 'label_only';
    }
    return (await blockRequest(s.subjectId, parentId)) ? 'removed' : 'label_only';
  }

  // A visible request on a Spot check. A slate pick the parent blocks leaves
  // the feed; a kid's own request is shadow-mode, so the label is all.
  const isSlatePick = s.requestSource !== null && SLATE_PICK_SOURCES.includes(s.requestSource);
  if (verdict === 'clear_no' && isSlatePick) {
    return (await blockRequest(s.subjectId, parentId)) ? 'removed' : 'label_only';
  }
  return 'label_only';
}

function existingDecision(s: Subject): boolean {
  return db.prepare(
    'SELECT 1 FROM guard_decisions WHERE subject_type = ? AND subject_id = ?',
  ).get(s.subjectType, s.subjectId) !== undefined;
}

export async function recordDecision(
  parentId: string,
  input: DecisionInput,
  now: Date = new Date(),
): Promise<DecisionOutcome> {
  const s = readSubject(input.subjectType, input.subjectId);
  const guard = s.subjectType === 'request'
    ? shownEvalForRequest(s.subjectId)
    : shownEvalForCandidate(s.subjectId, s.url, s.guardVerdict);

  if (existingDecision(s)) {
    const prior = db.prepare(
      'SELECT source FROM guard_decisions WHERE subject_type = ? AND subject_id = ?',
    ).get(s.subjectType, s.subjectId) as { source: DecisionSource };
    return { subjectType: s.subjectType, subjectId: s.subjectId, source: prior.source, effect: 'label_only', alreadyDecided: true, guard };
  }

  const source = sourceFor(s);
  // Read before the effect: the band and verdict the parent decided against.
  const ageBand = getAgeBand(s.userId);
  const guardVerdict = s.guardVerdict;
  const effect = await applyEffect(s, input.verdict, parentId);

  const at = now.toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO guard_decisions
        (decision_id, subject_type, subject_id, user_id, url, youtube_id, age_band,
         rubric_version, source, guard_verdict, eval_id, human_verdict, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv7(), s.subjectType, s.subjectId, s.userId, s.url, s.youtubeId, ageBand,
      RUBRIC_VERSION, source, guardVerdict, guard.evalId, input.verdict, parentId, at,
    );
    if (guard.evalId) labelGuardEval(guard.evalId, input.verdict, at);
  })();

  logger.info(
    { subjectType: s.subjectType, subjectId: s.subjectId, source, verdict: input.verdict, effect },
    'Parent decision recorded',
  );
  return { subjectType: s.subjectType, subjectId: s.subjectId, source, effect, alreadyDecided: false, guard };
}
