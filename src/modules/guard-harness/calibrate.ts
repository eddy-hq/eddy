// Calibration (brief §22 step 2, ADR-0017 "Calibrated scores"): does the
// model's probability of a score over its limit separate the Unsafe items the
// rubric guard passes from the Allowed ones it rightly passes?
//
// A logprob adapter stores a distribution over 0–3 per dimension. For an
// item's age band, p_over is the largest probability, over the eight
// dimensions, that the score exceeds its limit. The calibrated verdict keeps
// the plain (decoded-score) verdict, except that a clear_yes with p_over at or
// above a threshold τ becomes uncertain. It only ever tightens, and fails
// closed: a missing distribution counts as not provably under.
//
// τ* is pre-registered and picked on non-holdout only: among the τ on the grid
// whose projected live uncertain rate is at most a cap U (default 20%), find
// the fewest Unsafe items passed as clear_yes; τ* is the loosest τ reaching
// that minimum. If no τ is under the cap there is no τ*.
//
// The cap reads a projected live rate, not the labelled items' (ADR-0019,
// amended 2026-10-30). Every escalation is decided but clear verdicts are only
// sampled, so labelled items over-represent escalations. The projection is the
// live candidate prompt's uncertain share, plus its clear-yes share times the
// fraction of audited clear-yes items (live verdict clear_yes from that same
// prompt version, replayed clear_yes, non-holdout, any label) that τ would
// escalate. An audit from another prompt, or of unknown provenance, samples a
// different population and is left out. Calibration only
// turns a clear_yes into uncertain, so that is the whole change, and labels
// play no part in it. The brief's targets (clear-yes ≥ 95%,
// uncertain 10–30%) are reported against τ* for reference but don't pick it:
// when the incumbent already meets them, "loosest τ meeting the targets" is
// the loosest τ, which changes nothing and leaves the holdout nothing to test.
//
// p_over and the tightening rule live in the guard module (calibration.ts),
// which the live candidate guard applies with τ from GUARD_CALIBRATION_TAU
// (ADR-0017, amended 2026-10-30); this file sweeps and picks τ on replay.
// Imported from that DB-free file directly: the guard index loads the DB.
// Safety labels only (Allow = clear-yes, Unsafe = clear-no; Not for us and
// unrecorded left out), counts and metrics only (ADR-0004).
import { pOver, tightenVerdict as tighten, type Limits } from '../guard/calibration';
import { scoreSegment, type SafetyScore } from './report';
import { safetyLabel, wilsonInterval, type Interval } from './scorer';
import {
  THRESHOLDS,
  type GuardVerdictLabel,
  type HarnessItem,
  type HarnessResult,
  type HumanLabel,
  type ScoreDistribution,
} from './util';

export { pOver, type Limits };

// The plain verdict tightened by τ: clear_yes stays clear_yes only when
// p_over is known and below τ; anything else is unchanged.
export function calibratedVerdict(
  plain: GuardVerdictLabel,
  distributions: Readonly<Record<string, ScoreDistribution | null>> | undefined,
  limits: Limits,
  tau: number,
): GuardVerdictLabel {
  return tighten(plain, pOver(distributions, limits), tau);
}

// The thresholds the sweep reports, and τ* is picked from.
export const TAU_GRID: readonly number[] = [
  0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5,
];

// The default ceiling on the uncertain rate τ* may cost, on non-holdout.
export const DEFAULT_UNCERTAIN_CAP = 0.2;

// Reliability bins over p_over: [low, high), the last closed.
export const RELIABILITY_EDGES: readonly number[] = [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1];

// The live candidate prompt's verdict counts over a recent window
// (guard_eval), for the projected uncertain rate.
export interface LiveRates {
  promptVersion: string;
  total: number;
  uncertain: number;
  clearYes: number;
}

interface Row {
  itemId: string;
  holdout: boolean;
  label: HumanLabel;
  plain: GuardVerdictLabel;
  pOver: number | null;
}

export interface CalibrationPoint extends SafetyScore {
  tau: number | null;
  // Sweep points only: the live uncertain rate this τ is projected to give,
  // which the cap applies to. Null off the sweep or with no live rates or
  // audited items to project from.
  projectedUncertainRate: number | null;
  // Unsafe items the verdicts passed as clear_yes, of all Unsafe items.
  unsafePassed: number;
  unsafeTotal: number;
}

export interface ReliabilityBin {
  low: number;
  high: number;
  n: number;
  unsafe: number;
  rate: number | null;
  interval: Interval | null;
  meanPOver: number | null;
}

export interface Baseline {
  adapterId: string;
  // Calibration items the baseline has a result for, of all of them.
  covered: number;
  of: number;
  nonHoldout: CalibrationPoint;
  holdout: CalibrationPoint;
}

export interface CalibrationReport {
  adapterId: string;
  datasetItems: number;
  // Dataset items with a result from the adapter.
  scored: number;
  excluded: { notForUs: number; unrecorded: number };
  // Safety-labelled items with a result, by split.
  nonHoldoutItems: number;
  holdoutItems: number;
  // Of those whose plain verdict is clear_yes, how many have no p_over (a
  // distribution missing), which every τ escalates.
  clearYesWithoutPOver: { nonHoldout: number; holdout: number };
  // The adapter's own plain verdicts (no τ).
  plain: { nonHoldout: CalibrationPoint; holdout: CalibrationPoint };
  baseline: Baseline | null;
  sweep: CalibrationPoint[];
  // The uncertain-rate cap τ* was chosen under, on the projected live rate.
  uncertainCap: number;
  // What the projection was made from: the live rates, and the audited
  // clear-yes items (live clear_yes from the same prompt version, replayed
  // clear_yes, non-holdout) it scales.
  live: LiveRates | null;
  auditedClearYes: number;
  // The fewest Unsafe passed as clear_yes by any τ under the cap on
  // non-holdout; null when no τ is under it.
  minUnsafePassed: number | null;
  // The loosest τ reaching that minimum, and its one honest test on the
  // holdout.
  tauStar: number | null;
  holdoutAtTauStar: CalibrationPoint | null;
  // Non-holdout items whose plain verdict is clear_yes, binned by p_over.
  reliability: ReliabilityBin[];
}

function point(rows: readonly Row[], verdictOf: (r: Row) => GuardVerdictLabel, tau: number | null): CalibrationPoint {
  // Rows hold safety labels already: every clear_no is an Unsafe Block.
  const labelled = rows.map((r) => ({
    verdict: verdictOf(r),
    label: r.label,
    blockKind: r.label === 'clear_no' ? ('unsafe' as const) : null,
  }));
  const score = scoreSegment(labelled);
  return {
    ...score,
    tau,
    projectedUncertainRate: null,
    unsafePassed: score.matrix.clear_yes.clear_no,
    unsafeTotal: rows.filter((r) => r.label === 'clear_no').length,
  };
}

// Whether a point meets the clear-yes precision target and the uncertain band
// (point estimates). Reported for reference; it doesn't pick τ*.
export function meetsTargets(p: SafetyScore): { clearYesPrecision: boolean; uncertainRate: boolean } {
  const { clearYesPrecision, uncertainRate } = p.metrics;
  return {
    clearYesPrecision: clearYesPrecision !== null && clearYesPrecision >= THRESHOLDS.clearYesPrecision,
    uncertainRate: uncertainRate !== null
      && uncertainRate >= THRESHOLDS.uncertainRate.min && uncertainRate <= THRESHOLDS.uncertainRate.max,
  };
}

// The selection rule: of the points with projected live uncertain rate ≤ cap,
// the fewest Unsafe passed, and the loosest τ reaching it.
export function pickTauStar(
  sweep: readonly CalibrationPoint[],
  uncertainCap: number,
): { tauStar: number | null; minUnsafePassed: number | null } {
  const eligible = sweep.filter((p) => p.tau !== null && p.projectedUncertainRate !== null && p.projectedUncertainRate <= uncertainCap);
  if (eligible.length === 0) return { tauStar: null, minUnsafePassed: null };
  const min = Math.min(...eligible.map((p) => p.unsafePassed));
  const tauStar = Math.max(...eligible.filter((p) => p.unsafePassed === min).map((p) => p.tau!));
  return { tauStar, minUnsafePassed: min };
}

function tauVerdict(tau: number) {
  return (r: Row): GuardVerdictLabel => tighten(r.plain, r.pOver, tau);
}

export function reliabilityBins(rows: readonly Row[], edges: readonly number[] = RELIABILITY_EDGES): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const low = edges[i]!;
    const high = edges[i + 1]!;
    const last = i === edges.length - 2;
    const inBin = rows.filter((r) => r.pOver !== null && r.pOver >= low && (last ? r.pOver <= high : r.pOver < high));
    const unsafe = inBin.filter((r) => r.label === 'clear_no').length;
    bins.push({
      low,
      high,
      n: inBin.length,
      unsafe,
      rate: inBin.length > 0 ? unsafe / inBin.length : null,
      interval: wilsonInterval(unsafe, inBin.length),
      meanPOver: inBin.length > 0 ? inBin.reduce((s, r) => s + r.pOver!, 0) / inBin.length : null,
    });
  }
  return bins;
}

export interface CalibrationInput {
  items: readonly HarnessItem[];
  results: readonly HarnessResult[];
  adapterId: string;
  // The incumbent to set beside it; null to leave the baseline out.
  baselineAdapterId: string | null;
  limitsFor: (ageBand: string) => Limits;
  grid?: readonly number[];
  // Ceiling on the projected live uncertain rate τ* may cost; default 20%.
  uncertainCap?: number;
  // The live candidate prompt's recent verdict counts; null leaves nothing to
  // project from, so no τ*.
  live: LiveRates | null;
}

// The live uncertain rate τ is projected to give: today's live uncertain share,
// plus the live clear-yes share τ would escalate, estimated from the audited
// clear-yes items. Null when there is nothing to project from.
export function projectedUncertainRate(
  live: LiveRates | null,
  auditedPOver: readonly (number | null)[],
  tau: number,
): number | null {
  if (!live || live.total === 0 || auditedPOver.length === 0) return null;
  const escalated = auditedPOver.filter((p) => tighten('clear_yes', p, tau) === 'uncertain').length;
  return live.uncertain / live.total + (live.clearYes / live.total) * (escalated / auditedPOver.length);
}

export function calibrationReport(input: CalibrationInput): CalibrationReport {
  const mine = new Map<string, HarnessResult>();
  const theirs = new Map<string, GuardVerdictLabel>();
  for (const r of input.results) {
    if (r.adapterId === input.adapterId) mine.set(r.itemId, r);
    else if (r.adapterId === input.baselineAdapterId) theirs.set(r.itemId, r.verdict);
  }

  const excluded = { notForUs: 0, unrecorded: 0 };
  let scored = 0;
  const rows: Row[] = [];
  // p_over of the audited clear-yes items the projection scales by.
  const audited: (number | null)[] = [];
  for (const item of input.items) {
    const result = mine.get(item.itemId);
    if (!result) continue;
    scored += 1;
    if (!item.holdout && item.guardVerdict === 'clear_yes' && result.verdict === 'clear_yes'
      && input.live !== null && item.livePromptVersion === input.live.promptVersion) {
      audited.push(pOver(result.distributions, input.limitsFor(item.ageBand)));
    }
    const label = safetyLabel(item.label, item.blockKind);
    if (label === 'not_for_us') excluded.notForUs += 1;
    else if (label === 'unrecorded') excluded.unrecorded += 1;
    else {
      rows.push({
        itemId: item.itemId,
        holdout: item.holdout,
        label,
        plain: result.verdict,
        pOver: pOver(result.distributions, input.limitsFor(item.ageBand)),
      });
    }
  }
  const nonHoldout = rows.filter((r) => !r.holdout);
  const holdout = rows.filter((r) => r.holdout);
  const plainOf = (r: Row) => r.plain;

  const sweep = (input.grid ?? TAU_GRID).map((tau) => ({
    ...point(nonHoldout, tauVerdict(tau), tau),
    projectedUncertainRate: projectedUncertainRate(input.live, audited, tau),
  }));
  const uncertainCap = input.uncertainCap ?? DEFAULT_UNCERTAIN_CAP;
  const { tauStar, minUnsafePassed } = pickTauStar(sweep, uncertainCap);

  let baseline: Baseline | null = null;
  if (input.baselineAdapterId !== null) {
    const covered = rows.filter((r) => theirs.has(r.itemId));
    const verdictOf = (r: Row) => theirs.get(r.itemId)!;
    baseline = {
      adapterId: input.baselineAdapterId,
      covered: covered.length,
      of: rows.length,
      nonHoldout: point(covered.filter((r) => !r.holdout), verdictOf, null),
      holdout: point(covered.filter((r) => r.holdout), verdictOf, null),
    };
  }

  const missing = (rs: readonly Row[]) => rs.filter((r) => r.plain === 'clear_yes' && r.pOver === null).length;
  return {
    adapterId: input.adapterId,
    datasetItems: input.items.length,
    scored,
    excluded,
    nonHoldoutItems: nonHoldout.length,
    holdoutItems: holdout.length,
    clearYesWithoutPOver: { nonHoldout: missing(nonHoldout), holdout: missing(holdout) },
    plain: { nonHoldout: point(nonHoldout, plainOf, null), holdout: point(holdout, plainOf, null) },
    baseline,
    sweep,
    uncertainCap,
    live: input.live,
    auditedClearYes: audited.length,
    minUnsafePassed,
    tauStar,
    holdoutAtTauStar: tauStar !== null ? point(holdout, tauVerdict(tauStar), tauStar) : null,
    reliability: reliabilityBins(nonHoldout.filter((r) => r.plain === 'clear_yes')),
  };
}
