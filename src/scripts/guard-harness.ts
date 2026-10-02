#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run guard:harness -- snapshot
 * npm run guard:harness -- run    [--adapter gemma-v4] [--dataset FILE] [--limit N]
 *                                 [--concurrency N] [--force]
 * npm run guard:harness -- report [--adapter gemma-v4] [--dataset FILE]
 *
 * Measures a guard configuration against the parent's decisions (brief §22,
 * issue #220).
 *
 *   snapshot  freezes guard_decisions, with the inputs the candidate guard
 *             reads and channel history as it stood at each decision, into
 *             harness/dataset-YYYY-MM-DD.jsonl beside the DB. Opens the DB
 *             read-only; never runs migrations.
 *   run       replays the newest dataset (or --dataset) through an adapter,
 *             caching each verdict in harness/results-YYYY-MM-DD.jsonl.
 *             Resumable. Refuses to start inside a discovery window unless
 *             --force. Writes nothing to the DB.
 *   report    confusion matrix and the three metrics against the brief's
 *             thresholds.
 *
 * Output is counts and metrics only — no titles, channels or reasons
 * (ADR-0004).
 */
import 'dotenv/config';
import path from 'node:path';
import { config } from '../config';
import {
  DEFAULT_ADAPTER,
  GUARD_VERDICTS,
  GuardHarnessError,
  HOLDOUT_PERCENT,
  HUMAN_LABELS,
  MAX_CONCURRENCY,
  THRESHOLDS,
  getAdapter,
  latestDatasetPath,
  readDataset,
  readResults,
  reportForAdapter,
  resultsPathFor,
  runHarness,
  snapshotToFile,
  summariseDataset,
} from '../modules/guard-harness/index';

interface Args {
  command: 'snapshot' | 'run' | 'report';
  adapter: string;
  dataset?: string;
  limit?: number;
  concurrency: number;
  force: boolean;
}

function positiveInt(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0) throw new GuardHarnessError(`${flag} needs a positive integer`);
  return n;
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'snapshot' && command !== 'run' && command !== 'report') {
    throw new GuardHarnessError('Usage: guard:harness -- snapshot | run | report [options]');
  }
  const args: Args = { command, adapter: DEFAULT_ADAPTER, concurrency: 1, force: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--adapter') args.adapter = rest[++i] ?? '';
    else if (a === '--dataset') args.dataset = rest[++i];
    else if (a === '--limit') args.limit = positiveInt('--limit', rest[++i]);
    else if (a === '--concurrency') args.concurrency = positiveInt('--concurrency', rest[++i]);
    else if (a === '--force') args.force = true;
    else throw new GuardHarnessError(`Unknown argument: ${a}`);
  }
  if (command === 'snapshot' && rest.length > 0) throw new GuardHarnessError('snapshot takes no options');
  if (command === 'report' && (args.limit !== undefined || args.force || args.concurrency !== 1)) {
    throw new GuardHarnessError('--limit, --concurrency and --force apply to run only');
  }
  if (args.concurrency > MAX_CONCURRENCY) {
    throw new GuardHarnessError(`--concurrency is capped at ${MAX_CONCURRENCY} (Ollama is shared with live traffic)`);
  }
  return args;
}

function printCounts(title: string, counts: Record<string, number>): void {
  console.log(`  ${title}`);
  for (const k of Object.keys(counts).sort()) console.log(`    ${k.padEnd(20)} ${String(counts[k]).padStart(5)}`);
}

const pct = (v: number | null): string => (v === null ? '   n/a' : `${(v * 100).toFixed(1).padStart(5)}%`);

function snapshot(): void {
  const r = snapshotToFile(config.DATABASE_PATH);
  const s = summariseDataset(r.items);
  console.log(`Dataset: ${r.datasetPath}`);
  console.log(`Decisions read:       ${r.decisions}`);
  console.log(`Dropped:              ${r.decisions - r.items.length}`);
  printCounts('Dropped by reason', r.dropped);
  console.log(`Items written:        ${s.total}`);
  console.log(`Holdout (~${HOLDOUT_PERCENT}%):        ${s.holdout}`);
  printCounts('By label', s.byLabel);
  printCounts('By subject type', s.bySubjectType);
}

function datasetPath(args: Args): string {
  return args.dataset ? path.resolve(args.dataset) : latestDatasetPath(config.DATABASE_PATH);
}

async function run(args: Args): Promise<number> {
  const adapter = getAdapter(args.adapter);
  const file = datasetPath(args);
  const resultsPath = resultsPathFor(file);
  console.log(`Dataset: ${file}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Adapter: ${adapter.id}`);
  let last = '';
  const r = await runHarness({
    items: readDataset(file),
    adapter,
    resultsPath,
    limit: args.limit,
    concurrency: args.concurrency,
    force: args.force,
    onProgress: (done, total) => {
      const line = `${done}/${total}`;
      if (line !== last) {
        process.stdout.write(`\r  ${line}`);
        last = line;
      }
    },
  });
  if (last) process.stdout.write('\n');
  console.log(`Dataset items:                   ${r.datasetItems}`);
  console.log(`Already evaluated (skipped):     ${r.alreadyEvaluated}`);
  console.log(`Selected this run:               ${r.selected}`);
  console.log(`Evaluated this run:              ${r.evaluated}`);
  if (r.scoringErrors > 0) console.log(`Model errors (retried next run): ${r.scoringErrors}`);
  if (r.meanCallMs !== null) console.log(`Mean seconds per call:           ${(r.meanCallMs / 1000).toFixed(2)}`);
  if (r.abortedAfterErrors) console.log('Stopped early: repeated model errors — check Ollama, then re-run to resume.');
  return r.abortedAfterErrors ? 1 : 0;
}

function report(args: Args): void {
  const adapter = getAdapter(args.adapter);
  const file = datasetPath(args);
  const r = reportForAdapter(readDataset(file), readResults(resultsPathFor(file)), adapter.id);
  console.log(`Dataset: ${path.basename(file)}`);
  console.log(`Adapter: ${r.adapterId}`);
  console.log(`Scored:  ${r.scored} of ${r.datasetItems} items`);
  console.log('\nConfusion matrix (rows: guard verdict, columns: parent label)');
  console.log(`  ${''.padEnd(12)}${HUMAN_LABELS.map((l) => l.padStart(11)).join('')}${'total'.padStart(8)}`);
  for (const v of GUARD_VERDICTS) {
    const row = r.matrix[v];
    const total = row.clear_yes + row.clear_no;
    console.log(`  ${v.padEnd(12)}${HUMAN_LABELS.map((l) => String(row[l]).padStart(11)).join('')}${String(total).padStart(8)}`);
  }
  const m = r.metrics;
  const t = THRESHOLDS;
  console.log('\nMetric                 value    target');
  console.log(`  clear-yes precision  ${pct(m.clearYesPrecision)}   >= ${t.clearYesPrecision * 100}%`);
  console.log(`  clear-no precision   ${pct(m.clearNoPrecision)}   >= ${t.clearNoPrecision * 100}%`);
  console.log(`  uncertain rate       ${pct(m.uncertainRate)}   ${t.uncertainRate.min * 100}-${t.uncertainRate.max * 100}%`);
  console.log('\nNo confidence intervals yet: point estimates on small counts can mislead.');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'snapshot') {
    snapshot();
    return 0;
  }
  if (args.command === 'run') return run(args);
  report(args);
  return 0;
}

main().then((code) => process.exit(code)).catch((err: unknown) => {
  if (err instanceof GuardHarnessError) {
    console.error(err.message);
  } else {
    console.error('Guard harness failed:', err);
  }
  process.exit(1);
});
