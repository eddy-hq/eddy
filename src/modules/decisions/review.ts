// Review (#223): a parent re-checks past decisions and changes them.
//
// A change is a revision, never an overwrite: guard_decisions keeps the
// first-pass label as recorded, and each change adds a guard_decision_revisions
// row. The latest revision is the current answer.
//
// A Block carries a kind (#227): unsafe, not for us, or not recorded. Both
// kinds are a Block (human_verdict 'clear_no') with the same effect, so a
// revision that only sets or changes the kind on a current Block is a label
// only: it is recorded, and nothing live changes.
//
// Kid safety is asymmetric. A change to Block always applies through the same
// path as a Block today (a pooled candidate is rejected; any copy of the video
// in the kid's feed leaves it via mark_parent_blocked). A change to Allow only
// acts on a candidate still waiting in the pool (applyCandidateParentVerdict),
// so it can be picked
// for a future slate; anything else is a label only. Review never puts a video
// into a kid's feed directly.
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { NotFoundError, ValidationError } from '../../errors';
import { logger } from '../../logger';
import { applyCandidateParentVerdict } from '../discovery';
import {
  RUBRIC_VERSION,
  shownEvalById,
  shownEvalForCandidate,
  shownEvalForRequest,
  type ShownEval,
} from '../guard';
import { findParentBlockableRequests } from '../requests';
import { blockRequest, readSubject, type DecisionEffect, type Subject } from './decide';
import { cardDescription, cardThumbnail, reasonOptions, type DecisionCard, type ReasonOptions } from './queue';
import {
  REVIEW_PAGE,
  blockKindFor,
  reasonColumns,
  reasonFromColumns,
  type BlockKind,
  type DecisionReason,
  type DecisionSource,
  type HumanVerdict,
  type ReviewFilter,
  type SubjectType,
} from './util';

// What a revision did to the kid's feed.
//   removed    a visible slate pick taken off the feed, file removed
//   blocked    a pooled candidate taken out of the pool
//   eligible   a pooled candidate can be picked for a future slate
//   label_only nothing live to change
export type RevisionEffect = Extract<DecisionEffect, 'removed' | 'blocked' | 'eligible' | 'label_only'>;

export interface ReviewDecision {
  decisionId: string;
  decidedAt: string;
  // The guard verdict the subject carried when the parent first decided.
  guardVerdict: string | null;
  // The first-pass answer, as recorded in guard_decisions.
  firstVerdict: HumanVerdict;
  // The first pass's Block kind; null on an Allow or when not recorded.
  firstBlockKind: BlockKind | null;
  firstReason: DecisionReason | null;
  // The current answer: the latest revision's, else the first pass.
  verdict: HumanVerdict;
  blockKind: BlockKind | null;
  reason: DecisionReason | null;
  // The latest revision, and how many there have been; null if never revised.
  revision: { revisedAt: string; effect: RevisionEffect; count: number } | null;
}

// One decision per card (a decision is about one kid), in the queue's card
// shape so the PWA reuses its card pieces.
export interface ReviewCard extends DecisionCard {
  decision: ReviewDecision;
}

export interface ReviewPage {
  filter: ReviewFilter;
  cards: ReviewCard[];
  reasons: ReasonOptions;
  counts: { disagreements: number; all: number };
  // Offset of the next page, or null when this is the last.
  nextOffset: number | null;
}

export interface RevisionInput {
  decisionId: string;
  verdict: HumanVerdict;
  // What a Block meant; absent is "kind not recorded". Ignored on an Allow.
  blockKind?: BlockKind | null;
  reason?: DecisionReason | null;
}

export interface RevisionOutcome {
  decisionId: string;
  revisionId: string;
  verdict: HumanVerdict;
  blockKind: BlockKind | null;
  effect: RevisionEffect;
  // The decision's card after the change.
  card: ReviewCard;
}

// The current answer for each decision: the latest revision, else the first
// pass. The kind comes from the same row as the verdict, so a revision to
// Allow (or a Block from an older client) leaves no stale kind behind.
const LATEST_REVISION = (col: string) => `
  (SELECT rv.${col} FROM guard_decision_revisions rv
    WHERE rv.decision_id = d.decision_id
    ORDER BY rv.revised_at DESC, rv.rowid DESC LIMIT 1)`;
const REVIEWED = `
  reviewed AS (
    SELECT d.*,
           COALESCE(${LATEST_REVISION('human_verdict')}, d.human_verdict) AS current_verdict,
           CASE WHEN EXISTS (SELECT 1 FROM guard_decision_revisions rv WHERE rv.decision_id = d.decision_id)
                THEN ${LATEST_REVISION('block_kind')}
                ELSE d.block_kind END AS current_block_kind
      FROM guard_decisions d
  )`;

// A disagreement on the first pass or on the current answer: a decision
// revised into agreement stays listed, so its change can be seen and undone.
const DISAGREES = `
  (x.guard_verdict IN ('clear_yes', 'clear_no')
   AND (x.guard_verdict != x.human_verdict OR x.guard_verdict != x.current_verdict))`;

interface ReviewRow {
  decision_id: string;
  subject_type: SubjectType;
  subject_id: string;
  user_id: string;
  kid_name: string;
  url: string;
  youtube_id: string | null;
  age_band: string;
  source: DecisionSource;
  guard_verdict: string | null;
  eval_id: string | null;
  human_verdict: HumanVerdict;
  block_kind: BlockKind | null;
  reason_dimensions_json: string | null;
  reason_text: string | null;
  decided_at: string;
  title: string | null;
  channel: string | null;
  channel_id: string | null;
  description: string | null;
}

interface RevisionRow {
  decision_id: string;
  human_verdict: HumanVerdict;
  block_kind: BlockKind | null;
  reason_dimensions_json: string | null;
  reason_text: string | null;
  effect: RevisionEffect;
  revised_at: string;
}

function selectRows(where: string, params: Record<string, unknown>, page?: { limit: number; offset: number }): ReviewRow[] {
  return db.prepare(`
    WITH ${REVIEWED}
    SELECT x.decision_id, x.subject_type, x.subject_id, x.user_id, u.display_name AS kid_name, x.url,
           COALESCE(x.youtube_id, cp.external_id, r.youtube_id) AS youtube_id,
           x.age_band, x.source, x.guard_verdict, x.eval_id, x.human_verdict, x.block_kind,
           x.reason_dimensions_json, x.reason_text, x.decided_at,
           COALESCE(cp.title, r.title) AS title,
           COALESCE(cp.channel, r.channel) AS channel,
           COALESCE(cp.channel_id, r.youtube_channel_id) AS channel_id,
           r.description
      FROM reviewed x
      JOIN users u ON u.user_id = x.user_id
      LEFT JOIN candidate_pool cp ON x.subject_type = 'candidate' AND cp.candidate_id = x.subject_id
      LEFT JOIN requests r        ON x.subject_type = 'request'   AND r.request_id   = x.subject_id
     WHERE ${where}
     ORDER BY x.decided_at DESC, x.decision_id DESC
     ${page ? 'LIMIT @limit OFFSET @offset' : ''}
  `).all({ ...params, ...(page ?? {}) }) as ReviewRow[];
}

// Every revision of the given decisions, oldest first.
function revisionsFor(decisionIds: readonly string[]): Map<string, RevisionRow[]> {
  const out = new Map<string, RevisionRow[]>();
  if (decisionIds.length === 0) return out;
  const placeholders = decisionIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT decision_id, human_verdict, block_kind, reason_dimensions_json, reason_text, effect, revised_at
      FROM guard_decision_revisions
     WHERE decision_id IN (${placeholders})
     ORDER BY revised_at ASC, rowid ASC
  `).all(...decisionIds) as RevisionRow[];
  for (const r of rows) {
    const list = out.get(r.decision_id);
    if (list) list.push(r);
    else out.set(r.decision_id, [r]);
  }
  return out;
}

// What the guard said, as the parent was shown it when an eval row was
// recorded; otherwise the subject's row behind the decided verdict. Also
// picks the row behind a Review card's "What the guard saw" (#225).
export function shownEvalForDecision(
  row: Pick<ReviewRow, 'eval_id' | 'subject_type' | 'subject_id' | 'url' | 'guard_verdict'>,
): ShownEval {
  const shown = row.eval_id ? shownEvalById(row.eval_id) : null;
  if (shown) return shown;
  return row.subject_type === 'request'
    ? shownEvalForRequest(row.subject_id)
    : shownEvalForCandidate(row.subject_id, row.url, row.guard_verdict);
}

function toCard(row: ReviewRow, revisions: readonly RevisionRow[]): ReviewCard {
  const latest = revisions.length > 0 ? revisions[revisions.length - 1]! : null;
  const firstReason = reasonFromColumns(row.reason_dimensions_json, row.reason_text);
  return {
    key: row.decision_id,
    source: row.source,
    url: row.url,
    youtubeId: row.youtube_id,
    title: row.title ?? '(untitled)',
    channel: row.channel,
    channelId: row.channel_id,
    description: cardDescription(row.youtube_id, row.description),
    thumbnailUrl: cardThumbnail(row.youtube_id),
    addedAt: row.decided_at,
    subjects: [{
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      userId: row.user_id,
      kidName: row.kid_name,
      ageBand: row.age_band,
      guard: shownEvalForDecision(row),
    }],
    decision: {
      decisionId: row.decision_id,
      decidedAt: row.decided_at,
      guardVerdict: row.guard_verdict,
      firstVerdict: row.human_verdict,
      firstBlockKind: row.block_kind,
      firstReason,
      verdict: latest?.human_verdict ?? row.human_verdict,
      blockKind: latest ? latest.block_kind : row.block_kind,
      reason: latest ? reasonFromColumns(latest.reason_dimensions_json, latest.reason_text) : firstReason,
      revision: latest ? { revisedAt: latest.revised_at, effect: latest.effect, count: revisions.length } : null,
    },
  };
}

function toCards(rows: readonly ReviewRow[]): ReviewCard[] {
  const revisions = revisionsFor(rows.map((r) => r.decision_id));
  return rows.map((r) => toCard(r, revisions.get(r.decision_id) ?? []));
}

function countDecisions(): { disagreements: number; all: number } {
  const row = db.prepare(`
    WITH ${REVIEWED}
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${DISAGREES} THEN 1 ELSE 0 END), 0) AS disagreements
      FROM reviewed x
  `).get() as { total: number; disagreements: number };
  return { disagreements: row.disagreements, all: row.total };
}

export interface ReviewOptions {
  filter: ReviewFilter;
  offset?: number;
  limit?: number;
}

// Past decisions, newest first: disagreements by default, or every decision
// (escalations included).
export function readReview(opts: ReviewOptions): ReviewPage {
  const limit = opts.limit ?? REVIEW_PAGE;
  const offset = opts.offset ?? 0;
  const where = opts.filter === 'all' ? '1 = 1' : DISAGREES;
  // One extra row says whether another page follows.
  const rows = selectRows(where, {}, { limit: limit + 1, offset });
  const more = rows.length > limit;
  return {
    filter: opts.filter,
    cards: toCards(rows.slice(0, limit)),
    reasons: reasonOptions(),
    counts: countDecisions(),
    nextOffset: more ? offset + limit : null,
  };
}

export function readReviewCard(decisionId: string): ReviewCard | null {
  const rows = selectRows('x.decision_id = @decisionId', { decisionId });
  return rows[0] ? toCards(rows)[0]! : null;
}

// The subject as it stands now, or null when its row has gone (an older
// pruned candidate): nothing live to change.
function currentSubject(type: SubjectType, id: string): Subject | null {
  try {
    return readSubject(type, id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// A change to Block always takes effect. A pooled candidate is rejected as a
// Block today does it; then every copy of the video in the kid's feed leaves
// it through the Block path (mark_parent_blocked), whatever brought it there:
// a slate pick, the kid's own request or a parent pick. Unlike a Spot check
// on a kid's own request (shadow mode, label only), a Review change is the
// parent overruling the earlier answer for this kid and video.
// The kid and video come from the decision row, so live copies are found even
// when the decided subject has gone (an older pruned candidate).
async function blockEffect(ref: DecisionRef, s: Subject | null, parentId: string): Promise<RevisionEffect> {
  let effect: RevisionEffect = 'label_only';
  if (s?.subjectType === 'candidate' && s.status !== 'requested'
    && applyCandidateParentVerdict(s.subjectId, 'clear_no').applied) {
    effect = 'blocked';
  }
  const youtubeId = s?.youtubeId ?? ref.youtube_id;
  const live = new Set(youtubeId ? findParentBlockableRequests(ref.user_id, youtubeId) : []);
  if (s?.subjectType === 'request') live.add(s.subjectId);
  for (const requestId of live) {
    if (await blockRequest(requestId, parentId)) effect = 'removed';
  }
  return effect;
}

async function revisionEffect(
  ref: DecisionRef,
  s: Subject | null,
  verdict: HumanVerdict,
  parentId: string,
): Promise<RevisionEffect> {
  if (verdict === 'clear_no') return blockEffect(ref, s, parentId);
  if (!s) return 'label_only';
  // Allow: only a candidate still waiting in the pool, never a request and
  // never a picked candidate (its copy is a request).
  if (s.subjectType !== 'candidate' || s.status === 'requested') return 'label_only';
  return applyCandidateParentVerdict(s.subjectId, 'clear_yes').applied ? 'eligible' : 'label_only';
}

// The parent's current answer for a kid and a video, when it is Block: the
// latest answer across every decision on the video for that kid, first passes
// and revisions alike, with when it was given. The download callback and the
// second pass read this so a request still in flight when the parent blocked
// it never becomes visible. A kind-only revision is not an answer and is left
// out, so tagging an old Block never outranks a later Allow.
export function currentParentBlock(userId: string, youtubeId: string): { parentId: string; at: string } | null {
  const row = db.prepare(`
    SELECT verdict, parent_id, at FROM (
      SELECT d.human_verdict AS verdict, d.decided_by AS parent_id, d.decided_at AS at, 0 AS seq
        FROM guard_decisions d
       WHERE d.user_id = @userId AND d.youtube_id = @youtubeId
      UNION ALL
      SELECT rv.human_verdict, rv.revised_by, rv.revised_at, rv.rowid
        FROM guard_decision_revisions rv
        JOIN guard_decisions d ON d.decision_id = rv.decision_id
       WHERE d.user_id = @userId AND d.youtube_id = @youtubeId AND rv.kind_only = 0
    )
    ORDER BY at DESC, seq DESC
    LIMIT 1
  `).get({ userId, youtubeId }) as { verdict: string; parent_id: string; at: string } | undefined;
  return row?.verdict === 'clear_no' ? { parentId: row.parent_id, at: row.at } : null;
}

interface DecisionRef {
  decision_id: string;
  subject_type: SubjectType;
  subject_id: string;
  user_id: string;
  youtube_id: string | null;
  current_verdict: HumanVerdict;
  current_block_kind: BlockKind | null;
}

function readDecisionRef(decisionId: string): DecisionRef {
  const row = db.prepare(`
    WITH ${REVIEWED}
    SELECT decision_id, subject_type, subject_id, user_id, youtube_id, current_verdict, current_block_kind
      FROM reviewed WHERE decision_id = ?
  `).get(decisionId) as DecisionRef | undefined;
  if (!row) throw new NotFoundError(`decision ${decisionId}`);
  return row;
}

export async function reviseDecision(
  parentId: string,
  input: RevisionInput,
  now: Date = new Date(),
): Promise<RevisionOutcome> {
  const before = readDecisionRef(input.decisionId);
  const blockKind = blockKindFor(input.verdict, input.blockKind);
  // Same verdict: only a Block given a new kind is a change. A missing kind
  // (an older client) never clears a recorded one.
  const kindOnly = before.current_verdict === input.verdict;
  if (kindOnly && (input.verdict !== 'clear_no' || blockKind === null || blockKind === before.current_block_kind)) {
    throw new ValidationError(`decision ${input.decisionId} already has that answer`);
  }
  // Persist the answer before any effect is awaited. A download completing
  // while removals run reads the parent's current answer (currentParentBlock),
  // so a Block must already be on record or an in-flight copy can still
  // become visible. The effect column starts as label_only and is set once
  // the effects have run.
  const revisionId = uuidv7();
  const reason = reasonColumns(input.reason);
  db.prepare(`
    INSERT INTO guard_decision_revisions
      (revision_id, decision_id, human_verdict, block_kind, rubric_version, reason_dimensions_json, reason_text,
       effect, kind_only, revised_by, revised_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'label_only', ?, ?, ?)
  `).run(
    revisionId, input.decisionId, input.verdict, blockKind, RUBRIC_VERSION, reason.dimensionsJson, reason.text,
    kindOnly ? 1 : 0, parentId, now.toISOString(),
  );

  // A kind-only change keeps the Block it was: nothing live to change.
  const effect = kindOnly
    ? 'label_only'
    : await revisionEffect(before, currentSubject(before.subject_type, before.subject_id), input.verdict, parentId);
  db.prepare('UPDATE guard_decision_revisions SET effect = ? WHERE revision_id = ?').run(effect, revisionId);

  logger.info(
    {
      decisionId: input.decisionId, subjectType: before.subject_type, subjectId: before.subject_id,
      verdict: input.verdict, blockKind, kindOnly, effect,
      // Whether a reason came with it, never the note itself.
      withReason: reason.dimensionsJson !== null || reason.text !== null,
    },
    'Parent decision revised',
  );

  const card = readReviewCard(input.decisionId);
  if (!card) throw new NotFoundError(`decision ${input.decisionId}`);
  return { decisionId: input.decisionId, revisionId, verdict: input.verdict, blockKind, effect, card };
}
