// Guard harness (brief §22 step 1, issue #220): measure a guard configuration
// against the parent's decisions. Snapshot → run → report; see
// src/scripts/guard-harness.ts for the CLI.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openReadOnlyDatabase } from '../../db/client';
import { buildSnapshot, type SnapshotResult } from './snapshot';
import { scorePairs, type ConfusionMatrix, type Metrics, type ScoredPair } from './scorer';
import {
  datasetFileName,
  GuardHarnessError,
  harnessDir,
  parseHarnessItem,
  readJsonl,
  writeJsonl,
  type HarnessItem,
  type HarnessResult,
} from './util';

export { DEFAULT_ADAPTER, adapterNames, getAdapter } from './adapters';
export { MAX_CONCURRENCY, readResults, runHarness, type RunReport } from './runner';
export { buildSnapshot, channelHistoryAsOf, summariseDataset, type DropReason, type SnapshotResult } from './snapshot';
export {
  GUARD_VERDICTS,
  HUMAN_LABELS,
  confusionMatrix,
  metricsFromMatrix,
  scorePairs,
  type ConfusionMatrix,
  type Metrics,
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
  resultsPathFor,
  type AdapterJudgement,
  type HarnessAdapter,
  type HarnessItem,
  type HarnessResult,
} from './util';

// Snapshot the decisions in the DB at `databasePath` into a new dataset file
// in the harness dir beside it. Opens the DB read-only. Refuses to overwrite
// an existing dataset: a snapshot is frozen once written.
export function snapshotToFile(databasePath: string, now: Date = new Date()): SnapshotResult & { datasetPath: string } {
  const dir = harnessDir(databasePath);
  const datasetPath = path.join(dir, datasetFileName(now));
  if (existsSync(datasetPath)) {
    throw new GuardHarnessError(`${path.basename(datasetPath)} already exists — a snapshot is frozen once written`);
  }
  const source = openReadOnlyDatabase(databasePath);
  let result: SnapshotResult;
  try {
    // One read transaction, so the decisions and the history they are
    // checked against come from the same moment.
    result = source.transaction(() => buildSnapshot(source))();
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

export interface AdapterReport {
  adapterId: string;
  datasetItems: number;
  scored: number;
  matrix: ConfusionMatrix;
  metrics: Metrics;
}

// Score one adapter's cached results against the dataset's labels. Results
// for items not in the dataset are ignored.
export function reportForAdapter(
  items: readonly HarnessItem[],
  results: readonly HarnessResult[],
  adapterId: string,
): AdapterReport {
  const verdicts = new Map<string, HarnessResult['verdict']>();
  for (const r of results) if (r.adapterId === adapterId) verdicts.set(r.itemId, r.verdict);
  const pairs: ScoredPair[] = [];
  for (const item of items) {
    const verdict = verdicts.get(item.itemId);
    if (verdict) pairs.push({ verdict, label: item.label });
  }
  const { matrix, metrics } = scorePairs(pairs);
  return { adapterId, datasetItems: items.length, scored: pairs.length, matrix, metrics };
}
