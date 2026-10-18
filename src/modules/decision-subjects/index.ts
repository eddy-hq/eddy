// Decision subjects: which candidate_pool and requests rows a parent decision
// or a drawn spot check refers to. A label needs its subject row to be
// replayable through the guard (ADR-0014, ADR-0019) — a hard-deleted subject
// is dropped from the harness snapshot as subject_missing — so every hard
// delete of either table ANDs in the fragment below.
//
// Deliberately a dependency-free leaf. The decisions module owns the tables,
// but its index.ts carries the router and imports discovery and requests, so
// importing it from those modules (and from interests) would add load-time
// import cycles.

export type DecisionSubjectType = 'candidate' | 'request';

// SQL fragment: true when no parent decision and no drawn spot check refers to
// the subject whose id is `idExpr` (a column reference such as
// `candidate_pool.candidate_id`). A drawn check that has since been decided is
// covered by the decisions clause; one still waiting is a label to come.
export function notDecidedOrDrawnSql(subjectType: DecisionSubjectType, idExpr: string): string {
  return `(NOT EXISTS (
    SELECT 1 FROM guard_decisions d
     WHERE d.subject_type = '${subjectType}'
       AND d.subject_id = ${idExpr}
  )
  AND NOT EXISTS (
    SELECT 1 FROM guard_spot_checks s
     WHERE s.subject_type = '${subjectType}'
       AND s.subject_id = ${idExpr}
  ))`;
}
