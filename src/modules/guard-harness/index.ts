// Guard harness (brief §22 step 1, issue #220): measure a guard configuration
// against the parent's decisions. Recover → snapshot → run → report; see
// src/scripts/guard-harness.ts for the CLI.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openReadOnlyDatabase } from '../../db/read-only';
import { liveUncertainRates, type PromptUncertainRate } from './report';
import { buildSnapshot, type SnapshotResult } from './snapshot';
import {
  datasetFileName,
  GuardHarnessError,
  harnessDir,
  parseHarnessItem,
  readJsonl,
  readRecoveredInputs,
  recoveredInputsPath,
  writeJsonl,
  type HarnessItem,
} from './util';

export {
  DEFAULT_ADAPTER,
  DEFAULT_LOGPROB_ADAPTER,
  INCUMBENT_ADAPTER,
  adapterNames,
  getAdapter,
  loadRubricLimits,
} from './adapters';
export {
  RELIABILITY_EDGES,
  TAU_GRID,
  calibratedVerdict,
  calibrationReport,
  meetsTargets,
  pOver,
  type CalibrationPoint,
  type CalibrationReport,
  type ReliabilityBin,
} from './calibrate';
export { calibrationChartHtml, writeCalibrationChart } from './calibration-chart';
export { RECOVER_BATCH_SIZE, recoverInputs, selectMissingCandidates, type FetchVideos, type RecoverReport } from './recover';
export {
  LIVE_UNCERTAIN_DAYS,
  RUBRIC_FAMILY,
  SPLIT_NAMES,
  liveReport,
  liveUncertainRates,
  promptFamily,
  reportForAdapter,
  scoreLive,
  scoreSegment,
  type AdapterReport,
  type ConservativeClearYes,
  type LiveReport,
  type LiveScore,
  type PromptUncertainRate,
  type SafetyScore,
  type Splits,
} from './report';
export { MAX_CONCURRENCY, readResults, runHarness, type RunReport } from './runner';
export { buildSnapshot, channelHistoryAsOf, summariseDataset, type DropReason, type SnapshotResult } from './snapshot';
export {
  GUARD_VERDICTS,
  HUMAN_LABELS,
  confusionMatrix,
  metricIntervals,
  metricsFromMatrix,
  safetyLabel,
  scorePairs,
  scoreSafety,
  wilsonInterval,
  type ConfusionMatrix,
  type Interval,
  type LabelledVerdict,
  type MetricIntervals,
  type Metrics,
  type SafetyExcluded,
  type SafetyLabel,
  type ScoredPair,
} from './scorer';
export {
  AdapterScoringError,
  DISCOVERY_WINDOWS,
  GuardHarnessError,
  HOLDOUT_PERCENT,
  THRESHOLDS,
  harnessDir,
  inDiscoveryWindow,
  isHoldout,
  recoveredInputsPath,
  resultsPathFor,
  type AdapterJudgement,
  type BlockKind,
  type HarnessAdapter,
  type HarnessItem,
  type HarnessResult,
  type ItemInputs,
  type RecoveredInput,
  type ScoreDistribution,
} from './util';

// Where calibrate writes its chart: harness/calibration-<dataset>.html
// beside the DB.
export function calibrationChartPath(databasePath: string, datasetPath: string): string {
  return path.join(harnessDir(databasePath), `calibration-${path.basename(datasetPath, '.jsonl')}.html`);
}

// Snapshot the decisions in the DB at `databasePath` into a new dataset file
// in the harness dir beside it, using any recovered inputs there. Opens the
// DB read-only. Refuses to overwrite an existing dataset: a snapshot is
// frozen once written.
export function snapshotToFile(databasePath: string, now: Date = new Date()): SnapshotResult & { datasetPath: string } {
  const dir = harnessDir(databasePath);
  const datasetPath = path.join(dir, datasetFileName(now));
  if (existsSync(datasetPath)) {
    throw new GuardHarnessError(`${path.basename(datasetPath)} already exists — a snapshot is frozen once written`);
  }
  const recovered = readRecoveredInputs(recoveredInputsPath(databasePath));
  const source = openReadOnlyDatabase(databasePath);
  let result: SnapshotResult;
  try {
    // One read transaction, so the decisions and the history they are
    // checked against come from the same moment.
    result = source.transaction(() => buildSnapshot(source, recovered))();
  } finally {
    source.close();
  }
  mkdirSync(dir, { recursive: true });
  writeJsonl(datasetPath, result.items);
  return { ...result, datasetPath };
}

export function readDataset(datasetPath: string): HarnessItem[] {
  if (!existsSync(datasetPath)) throw new GuardHarnessError(`No dataset at ${datasetPath}`);
  return readJsonl(datasetPath, parseHarnessItem);
}

// The newest dataset-YYYY-MM-DD.jsonl in the harness dir.
export function latestDatasetPath(databasePath: string): string {
  const dir = harnessDir(databasePath);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^dataset-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    : [];
  const latest = files[files.length - 1];
  if (!latest) throw new GuardHarnessError(`No dataset in ${dir} — run the snapshot first`);
  return path.join(dir, latest);
}

// The uncertain rate of every recorded guard verdict per prompt version over
// the last 14 days (offline re-runs included; see liveUncertainRates),
// from guard_eval. Opens the DB read-only.
export function liveUncertainRatesFromFile(databasePath: string, now: Date = new Date()): PromptUncertainRate[] {
  const source = openReadOnlyDatabase(databasePath);
  try {
    return liveUncertainRates(source, now);
  } finally {
    source.close();
  }
}
