// The read behind `npm run label-guard`, split out so it can be tested
// without the interactive CLI.
import { db } from '../db/client';

export interface EvalRow {
  eval_id: string;
  request_id: string | null;
  url: string;
  title: string | null;
  channel: string | null;
  gemma_verdict: string | null;
  gemma_reason: string | null;
  gemma_confidence: number | null;
  scored_at: string | null;
  created_at: string;
}

// Unlabelled guard verdicts, oldest first. A verdict on a request that is now
// a parent pick (#217) is left out: the parent's choice replaced the guard's,
// so it doesn't belong in the eval set. The row itself is kept.
export function readUnlabelledEvals(): EvalRow[] {
  return db.prepare(`
    SELECT
      ge.eval_id, ge.request_id, ge.url,
      r.title, r.channel,
      ge.gemma_verdict, ge.gemma_reason, ge.gemma_confidence,
      ge.scored_at, ge.created_at
    FROM guard_eval ge
    LEFT JOIN requests r ON ge.request_id = r.request_id
    WHERE ge.human_verdict IS NULL
      AND (r.source IS NULL OR r.source != 'parent_pick')
    ORDER BY COALESCE(ge.scored_at, ge.created_at) ASC
  `).all() as EvalRow[];
}
