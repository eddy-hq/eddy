// The guard_eval side of parent decisions (Phase 6a). The parent surface shows
// the verdict a subject carries; these find the guard_eval row behind it and,
// once the parent decides, label that row. Labels themselves live in
// guard_decisions (decisions module): this only mirrors them onto guard_eval
// when the row is unambiguous.
import { db } from '../../db/client';
import { DIMENSION_KEYS, type RubricDimension } from './rubric';

export interface ShownEval {
  // Set only when the row is unambiguously this subject's: a request's own
  // row, or a candidate row that records the candidate. Older candidate rows
  // carry only a URL, which both kids' pools can share.
  evalId: string | null;
  verdict: string | null;
  reason: string | null;
  // Rubric dimension scores when a rubric-scored row exists for the subject.
  // Severity is scored band-independently, so any kid's row serves.
  scores: Record<RubricDimension, number> | null;
}

interface EvalRow {
  eval_id: string;
  gemma_verdict: string | null;
  gemma_reason: string | null;
}

function parseDimensions(json: string | null | undefined): ShownEval['scores'] {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { dimensions?: Record<string, unknown> };
    const dims = parsed.dimensions;
    if (!dims) return null;
    const out = {} as Record<RubricDimension, number>;
    for (const k of DIMENSION_KEYS) {
      const v = dims[k];
      if (typeof v !== 'number') return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function shownEvalForRequest(requestId: string): ShownEval {
  const row = db.prepare(
    `SELECT eval_id, gemma_verdict, gemma_reason FROM guard_eval
      WHERE request_id = ? ORDER BY scored_at DESC LIMIT 1`,
  ).get(requestId) as EvalRow | undefined;
  const scored = db.prepare(
    `SELECT rubric_scores_json FROM guard_eval
      WHERE request_id = ? AND rubric_scores_json IS NOT NULL
      ORDER BY scored_at DESC LIMIT 1`,
  ).get(requestId) as { rubric_scores_json: string } | undefined;
  return {
    evalId: row?.eval_id ?? null,
    verdict: row?.gemma_verdict ?? null,
    reason: row?.gemma_reason ?? null,
    scores: parseDimensions(scored?.rubric_scores_json),
  };
}

// The row behind a candidate's current guard_verdict: the latest candidate
// row with that verdict, preferring one that records this candidate.
export function shownEvalForCandidate(candidateId: string, url: string, guardVerdict: string | null): ShownEval {
  const own = db.prepare(
    `SELECT eval_id, gemma_verdict, gemma_reason FROM guard_eval
      WHERE candidate_id = ? AND (? IS NULL OR gemma_verdict = ?)
      ORDER BY scored_at DESC LIMIT 1`,
  ).get(candidateId, guardVerdict, guardVerdict) as EvalRow | undefined;
  const byUrl = own ? undefined : db.prepare(
    `SELECT eval_id, gemma_verdict, gemma_reason FROM guard_eval
      WHERE url = ? AND candidate_id IS NULL AND request_type = 'candidate'
        AND (? IS NULL OR gemma_verdict = ?)
      ORDER BY scored_at DESC LIMIT 1`,
  ).get(url, guardVerdict, guardVerdict) as EvalRow | undefined;
  const scored = db.prepare(
    `SELECT rubric_scores_json FROM guard_eval
      WHERE (candidate_id = ? OR (url = ? AND candidate_id IS NULL AND request_type = 'candidate'))
        AND rubric_scores_json IS NOT NULL
      ORDER BY scored_at DESC LIMIT 1`,
  ).get(candidateId, url) as { rubric_scores_json: string } | undefined;
  const row = own ?? byUrl;
  return {
    evalId: own?.eval_id ?? null,
    verdict: row?.gemma_verdict ?? guardVerdict,
    reason: row?.gemma_reason ?? null,
    scores: parseDimensions(scored?.rubric_scores_json),
  };
}

// Mirror a parent's label onto the guard_eval row they were shown.
export function labelGuardEval(evalId: string, humanVerdict: 'clear_yes' | 'clear_no', at: string): void {
  db.prepare(
    `UPDATE guard_eval SET human_verdict = ?, human_labelled_at = ? WHERE eval_id = ?`,
  ).run(humanVerdict, at, evalId);
}
