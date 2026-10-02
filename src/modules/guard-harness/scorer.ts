// Scorer: pure functions over (guard verdict, human label) pairs. The parent's
// label is the truth; the guard's verdict is the prediction.
//
//   clear-yes precision: of what the guard cleared, the share the parent
//                        allowed (a miss is unsafe content reaching a kid)
//   clear-no precision:  of what the guard rejected, the share the parent
//                        blocked (a miss is good content wrongly rejected)
//   uncertain rate:      the share the guard escalated
//
// Each is null when its denominator is zero.
import type { GuardVerdictLabel, HumanLabel } from './util';

export const GUARD_VERDICTS: readonly GuardVerdictLabel[] = ['clear_yes', 'clear_no', 'uncertain'];
export const HUMAN_LABELS: readonly HumanLabel[] = ['clear_yes', 'clear_no'];

export type ConfusionMatrix = Record<GuardVerdictLabel, Record<HumanLabel, number>>;

export interface ScoredPair {
  verdict: GuardVerdictLabel;
  label: HumanLabel;
}

export interface Metrics {
  total: number;
  clearYesPrecision: number | null;
  clearNoPrecision: number | null;
  uncertainRate: number | null;
}

export function confusionMatrix(pairs: readonly ScoredPair[]): ConfusionMatrix {
  const m = {
    clear_yes: { clear_yes: 0, clear_no: 0 },
    clear_no: { clear_yes: 0, clear_no: 0 },
    uncertain: { clear_yes: 0, clear_no: 0 },
  };
  for (const p of pairs) m[p.verdict][p.label] += 1;
  return m;
}

function rowTotal(m: ConfusionMatrix, verdict: GuardVerdictLabel): number {
  return m[verdict].clear_yes + m[verdict].clear_no;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function metricsFromMatrix(m: ConfusionMatrix): Metrics {
  const total = GUARD_VERDICTS.reduce((sum, v) => sum + rowTotal(m, v), 0);
  return {
    total,
    clearYesPrecision: ratio(m.clear_yes.clear_yes, rowTotal(m, 'clear_yes')),
    clearNoPrecision: ratio(m.clear_no.clear_no, rowTotal(m, 'clear_no')),
    uncertainRate: ratio(rowTotal(m, 'uncertain'), total),
  };
}

export function scorePairs(pairs: readonly ScoredPair[]): { matrix: ConfusionMatrix; metrics: Metrics } {
  const matrix = confusionMatrix(pairs);
  return { matrix, metrics: metricsFromMatrix(matrix) };
}
