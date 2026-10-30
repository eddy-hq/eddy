// Report: score verdicts against the dataset's labels, overall and split by
// holdout and by where the inputs came from. Two sources of verdicts:
//
//   adapter  a configuration's cached replay results (`run`)
//   live     the guard verdict each subject carried when the parent decided,
//            recorded on the decision; no model calls
//
// Safety only (#227): Allow is clear-yes, Unsafe is clear-no, Not for us and
// unrecorded Blocks are left out and counted. Every proportion carries a
// Wilson 95% interval. Counts and metrics only (ADR-0004).
import type { Database } from 'better-sqlite3';
import {
  GUARD_VERDICTS,
  metricIntervals,
  scoreSafety,
  wilsonInterval,
  type ConfusionMatrix,
  type Interval,
  type LabelledVerdict,
  type MetricIntervals,
  type Metrics,
  type SafetyExcluded,
} from './scorer';
import type { GuardVerdictLabel, HarnessItem, HarnessResult } from './util';

export interface SafetyScore {
  // Items scored, excluded ones included.
  scored: number;
  // The safety matrix and metrics: Allow and Unsafe labels only.
  matrix: ConfusionMatrix;
  metrics: Metrics;
  intervals: MetricIntervals;
  // Scored items left out of the safety metrics: Not for us, and Blocks
  // whose kind wasn't recorded.
  excluded: SafetyExcluded;
}

export function scoreSegment(labelled: readonly LabelledVerdict[]): SafetyScore {
  const { matrix, metrics, excluded } = scoreSafety(labelled);
  return { scored: labelled.length, matrix, metrics, intervals: metricIntervals(matrix), excluded };
}

// The same score, overall and on each side of the two fixed splits.
export interface Splits<T> {
  overall: T;
  holdout: T;
  nonHoldout: T;
  original: T;
  recovered: T;
}

export const SPLIT_NAMES: ReadonlyArray<Exclude<keyof Splits<unknown>, 'overall'>> = [
  'holdout', 'nonHoldout', 'original', 'recovered',
];

interface Scored {
  item: HarnessItem;
  verdict: GuardVerdictLabel;
}

function splits<T>(rows: readonly Scored[], score: (rows: readonly Scored[]) => T): Splits<T> {
  return {
    overall: score(rows),
    holdout: score(rows.filter((r) => r.item.holdout)),
    nonHoldout: score(rows.filter((r) => !r.item.holdout)),
    original: score(rows.filter((r) => r.item.inputs === 'original')),
    recovered: score(rows.filter((r) => r.item.inputs === 'recovered')),
  };
}

const toLabelled = (rows: readonly Scored[]): LabelledVerdict[] =>
  rows.map((r) => ({ verdict: r.verdict, label: r.item.label, blockKind: r.item.blockKind }));

// ── Adapter report ───────────────────────────────────────────────────────────

export interface AdapterReport extends SafetyScore {
  adapterId: string;
  datasetItems: number;
  splits: Omit<Splits<SafetyScore>, 'overall'>;
}

// Score one adapter's cached results against the dataset's labels, on safety
// only (#227). Results for items not in the dataset are ignored.
export function reportForAdapter(
  items: readonly HarnessItem[],
  results: readonly HarnessResult[],
  adapterId: string,
): AdapterReport {
  const verdicts = new Map<string, HarnessResult['verdict']>();
  for (const r of results) if (r.adapterId === adapterId) verdicts.set(r.itemId, r.verdict);
  const rows: Scored[] = [];
  for (const item of items) {
    const verdict = verdicts.get(item.itemId);
    if (verdict) rows.push({ item, verdict });
  }
  const { overall, ...rest } = splits(rows, (r) => scoreSegment(toLabelled(r)));
  return { adapterId, datasetItems: items.length, ...overall, splits: rest };
}

// ── Live report ──────────────────────────────────────────────────────────────

// Clear-yes precision if every Block of any kind, unrecorded included,
// counted as a miss: of what the guard cleared, the share the parent allowed.
// A floor on clear-yes precision (an upper bound on misses) while most Blocks
// carry no kind.
export interface ConservativeClearYes {
  allowed: number;
  blocked: number;
  precision: number | null;
  interval: Interval | null;
}

export interface LiveScore extends SafetyScore {
  conservativeClearYes: ConservativeClearYes;
}

export function scoreLive(rows: readonly LabelledVerdict[]): LiveScore {
  let allowed = 0;
  let blocked = 0;
  for (const r of rows) {
    if (r.verdict !== 'clear_yes') continue;
    if (r.label === 'clear_yes') allowed += 1;
    else blocked += 1;
  }
  const n = allowed + blocked;
  return {
    ...scoreSegment(rows),
    conservativeClearYes: { allowed, blocked, precision: n > 0 ? allowed / n : null, interval: wilsonInterval(allowed, n) },
  };
}

// The rubric prompts (candidate-v4, candidate-v4.1 and their second-pass
// counterparts) are one family; every other prompt stands on its own, and a
// decision with no recorded prompt is 'unknown'.
export const RUBRIC_FAMILY = 'v4 family';

export function promptFamily(version: string | null): string {
  if (!version) return 'unknown';
  return version.includes('v4') ? RUBRIC_FAMILY : version;
}

export interface LiveReport extends Splits<LiveScore> {
  datasetItems: number;
  // Items whose decision recorded no live verdict, or one the scorer doesn't
  // know: left out of every figure.
  noLiveVerdict: number;
  byPromptFamily: Record<string, LiveScore>;
  // escalation / spot_check / catch_up.
  byLabelSource: Record<string, LiveScore>;
}

function isVerdict(v: string | null): v is GuardVerdictLabel {
  return (GUARD_VERDICTS as readonly string[]).includes(v ?? '');
}

function groupBy(rows: readonly Scored[], key: (r: Scored) => string): Record<string, LiveScore> {
  const groups = new Map<string, Scored[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const out: Record<string, LiveScore> = {};
  for (const k of [...groups.keys()].sort()) out[k] = scoreLive(toLabelled(groups.get(k)!));
  return out;
}

// Score the live guard verdict each decision recorded against the current
// labels. Precision is readable for the clear verdicts only: escalations are
// all decided while clears are only sampled, so the share of uncertain
// verdicts among decisions says nothing about the live uncertain rate.
export function liveReport(items: readonly HarnessItem[]): LiveReport {
  const rows: Scored[] = [];
  let noLiveVerdict = 0;
  for (const item of items) {
    if (isVerdict(item.guardVerdict)) rows.push({ item, verdict: item.guardVerdict });
    else noLiveVerdict += 1;
  }
  return {
    datasetItems: items.length,
    noLiveVerdict,
    ...splits(rows, (r) => scoreLive(toLabelled(r))),
    byPromptFamily: groupBy(rows, (r) => promptFamily(r.item.livePromptVersion)),
    byLabelSource: groupBy(rows, (r) => r.item.decisionSource),
  };
}

// ── Live uncertain rate ──────────────────────────────────────────────────────

export const LIVE_UNCERTAIN_DAYS = 14;

export interface PromptUncertainRate {
  promptVersion: string | null;
  total: number;
  uncertain: number;
  clearYes: number;
  rate: number | null;
  interval: Interval | null;
}

// The uncertain rate per prompt version over every guard_eval row written in
// the last `days` days. Counts only.
//
// Not live traffic alone: guard:rerun-parked writes its offline re-runs to
// guard_eval under the same prompt versions (even without --apply), and no
// column tells them apart. A re-run of a selected backlog therefore moves
// this figure without any live verdict changing. The CLI says so; filtering
// them out needs provenance on guard_eval, which is a migration.
export function liveUncertainRates(
  source: Database,
  now: Date,
  days: number = LIVE_UNCERTAIN_DAYS,
): PromptUncertainRate[] {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = source.prepare(`
    SELECT prompt_version,
           COUNT(*)                                             AS total,
           COUNT(CASE WHEN gemma_verdict = 'uncertain' THEN 1 END) AS uncertain,
           COUNT(CASE WHEN gemma_verdict = 'clear_yes' THEN 1 END) AS clear_yes
    FROM guard_eval
    WHERE created_at >= ?
    GROUP BY prompt_version
    ORDER BY prompt_version
  `).all(since) as Array<{ prompt_version: string | null; total: number; uncertain: number; clear_yes: number }>;
  return rows.map((r) => ({
    promptVersion: r.prompt_version,
    total: r.total,
    uncertain: r.uncertain,
    clearYes: r.clear_yes,
    rate: r.total > 0 ? r.uncertain / r.total : null,
    interval: wilsonInterval(r.uncertain, r.total),
  }));
}
