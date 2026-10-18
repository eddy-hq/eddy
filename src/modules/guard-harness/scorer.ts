// Scorer: pure functions over (guard verdict, human label) pairs. The parent's
// label is the truth; the guard's verdict is the prediction.
//
// The metrics measure safety only (#227). A parent's Block is clear-no when
// its kind is 'unsafe'; a 'not_for_us' Block (quality, taste, relevance) and a
// Block whose kind wasn't recorded are left out and counted on their own.
//
//   clear-yes precision: of what the guard cleared, the share the parent
//                        allowed (a miss is guard approved, parent said
//                        unsafe: unsafe content reaching a kid)
//   clear-no precision:  of what the guard rejected, the share the parent
//                        said unsafe (a miss is good content wrongly rejected)
//   uncertain rate:      the share the guard escalated
//
// Each is null when its denominator is zero.
import type { BlockKind, GuardVerdictLabel, HumanLabel } from './util';

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

// ── Safety scoring (#227) ────────────────────────────────────────────────────

export interface LabelledVerdict {
  verdict: GuardVerdictLabel;
  label: HumanLabel;
  blockKind: BlockKind | null;
}

// Where one parent label lands in the safety metrics: an Allow is clear-yes,
// an Unsafe Block is clear-no, and anything else is excluded.
export type SafetyLabel = HumanLabel | 'not_for_us' | 'unrecorded';

export function safetyLabel(label: HumanLabel, blockKind: BlockKind | null): SafetyLabel {
  if (label === 'clear_yes') return 'clear_yes';
  if (blockKind === 'unsafe') return 'clear_no';
  return blockKind === 'not_for_us' ? 'not_for_us' : 'unrecorded';
}

export interface SafetyExcluded {
  notForUs: number;
  unrecorded: number;
}

export function scoreSafety(items: readonly LabelledVerdict[]): {
  matrix: ConfusionMatrix;
  metrics: Metrics;
  excluded: SafetyExcluded;
} {
  const pairs: ScoredPair[] = [];
  const excluded: SafetyExcluded = { notForUs: 0, unrecorded: 0 };
  for (const item of items) {
    const label = safetyLabel(item.label, item.blockKind);
    if (label === 'not_for_us') excluded.notForUs += 1;
    else if (label === 'unrecorded') excluded.unrecorded += 1;
    else pairs.push({ verdict: item.verdict, label });
  }
  return { ...scorePairs(pairs), excluded };
}

// ── Confidence intervals ─────────────────────────────────────────────────────

export interface Interval {
  low: number;
  high: number;
}

// z for a two-sided 95% interval.
const Z95 = 1.959963984540054;

// Wilson score interval for a proportion: successes out of n. Stays inside
// [0, 1] and behaves on small counts and at 0% or 100%, where the normal
// approximation collapses to a point. Null when n is zero.
export function wilsonInterval(successes: number, n: number, z: number = Z95): Interval | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Exact at the edges, where floating point would leave 1e-16 off.
  return {
    low: successes <= 0 ? 0 : Math.max(0, centre - half),
    high: successes >= n ? 1 : Math.min(1, centre + half),
  };
}

export interface MetricIntervals {
  clearYesPrecision: Interval | null;
  clearNoPrecision: Interval | null;
  uncertainRate: Interval | null;
}

// Wilson 95% intervals for the three metrics, on the same numerators and
// denominators as metricsFromMatrix.
export function metricIntervals(m: ConfusionMatrix): MetricIntervals {
  const total = GUARD_VERDICTS.reduce((sum, v) => sum + rowTotal(m, v), 0);
  return {
    clearYesPrecision: wilsonInterval(m.clear_yes.clear_yes, rowTotal(m, 'clear_yes')),
    clearNoPrecision: wilsonInterval(m.clear_no.clear_no, rowTotal(m, 'clear_no')),
    uncertainRate: wilsonInterval(rowTotal(m, 'uncertain'), total),
  };
}
