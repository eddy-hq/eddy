#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run guard:harness -- recover  [--force]
 * npm run guard:harness -- snapshot
 * npm run guard:harness -- run      [--adapter gemma-v4] [--dataset FILE] [--limit N]
 *                                   [--concurrency N] [--force]
 * npm run guard:harness -- report   [--adapter gemma-v4] [--dataset FILE]
 * npm run guard:harness -- report --live [--dataset FILE]
 *
 * Measures a guard configuration against the parent's decisions (brief §22,
 * issue #220).
 *
 *   recover   for decided candidates whose candidate_pool row has been
 *             pruned, fetches title, channel and channel id from the Data
 *             API (videos.list, 50 ids a call, through src/youtubeapi.ts and
 *             its key and quota tally) into harness/recovered-inputs.jsonl
 *             beside the DB, mode 0600, keyed by decision id. Opens the DB
 *             read-only. Skips decisions already recovered unless --force.
 *             Costs one quota unit per 50 videos.
 *   snapshot  freezes guard_decisions, with the inputs the candidate guard
 *             reads and channel history as it stood at each decision, into
 *             harness/dataset-YYYY-MM-DD.jsonl beside the DB. A pruned
 *             candidate is built from its recovered input when there is one
 *             (inputs: 'recovered'), else dropped as subject_missing. Each
 *             item records the live guard verdict and the prompt version it
 *             came from (guard_eval via guard_decisions.eval_id; null when
 *             unknown). Opens the DB read-only; never runs migrations.
 *   run       replays the newest dataset (or --dataset) through an adapter,
 *             caching each verdict in harness/results-dataset-YYYY-MM-DD.jsonl.
 *             Resumable. Refuses to start inside a discovery window unless
 *             --force. Writes nothing to the DB.
 *   report    confusion matrix and the three metrics, with Wilson 95%
 *             intervals, against the brief's thresholds, on safety only: a
 *             Block counts as clear-no when the parent said Unsafe; Not for
 *             us and Blocks with no recorded kind are left out and counted
 *             separately (#227). Split by holdout and by inputs (original or
 *             recovered) beside the overall figures.
 *   report --live
 *             scores the live guard verdict each decision recorded (no model
 *             calls) on the same safety rules, split by prompt family (every
 *             'v4' version as the rubric family), label source, holdout and
 *             inputs. Precision for the clear verdicts only: the uncertain
 *             rate can't be read from decisions, so the rate over every
 *             verdict recorded in guard_eval in the last 14 days is printed
 *             per prompt version instead (DB opened read-only). That
 *             includes offline re-runs (guard:rerun-parked), which guard_eval
 *             can't tell apart from live verdicts. Adds a conservative clear-yes precision
 *             counting every Block, any kind, as a miss.
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
  LIVE_UNCERTAIN_DAYS,
  MAX_CONCURRENCY,
  SPLIT_NAMES,
  THRESHOLDS,
  getAdapter,
  latestDatasetPath,
  liveReport,
  liveUncertainRatesFromFile,
  readDataset,
  readResults,
  recoverInputs,
  reportForAdapter,
  resultsPathFor,
  runHarness,
  snapshotToFile,
  summariseDataset,
  type ConfusionMatrix,
  type Interval,
  type LiveScore,
  type SafetyScore,
} from '../modules/guard-harness/index';

type Command = 'recover' | 'snapshot' | 'run' | 'report';
const COMMANDS: readonly string[] = ['recover', 'snapshot', 'run', 'report'];

interface Args {
  command: Command;
  adapter: string;
  adapterGiven: boolean;
  dataset?: string;
  limit?: number;
  concurrency: number;
  force: boolean;
  live: boolean;
}

function positiveInt(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0) throw new GuardHarnessError(`${flag} needs a positive integer`);
  return n;
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command === undefined || !COMMANDS.includes(command)) {
    throw new GuardHarnessError('Usage: guard:harness -- recover | snapshot | run | report [options]');
  }
  const args: Args = {
    command: command as Command, adapter: DEFAULT_ADAPTER, adapterGiven: false, concurrency: 1, force: false, live: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--adapter') {
      args.adapter = rest[++i] ?? '';
      args.adapterGiven = true;
    } else if (a === '--dataset') args.dataset = rest[++i];
    else if (a === '--limit') args.limit = positiveInt('--limit', rest[++i]);
    else if (a === '--concurrency') args.concurrency = positiveInt('--concurrency', rest[++i]);
    else if (a === '--force') args.force = true;
    else if (a === '--live') args.live = true;
    else throw new GuardHarnessError(`Unknown argument: ${a}`);
  }
  if (args.command === 'snapshot' && rest.length > 0) throw new GuardHarnessError('snapshot takes no options');
  if (args.command === 'recover' && rest.some((a) => a !== '--force')) {
    throw new GuardHarnessError('recover takes only --force');
  }
  if (args.command === 'report' && (args.limit !== undefined || args.force || args.concurrency !== 1)) {
    throw new GuardHarnessError('--limit, --concurrency and --force apply to run only');
  }
  if (args.live && args.command !== 'report') throw new GuardHarnessError('--live applies to report only');
  if (args.live && args.adapterGiven) {
    throw new GuardHarnessError('report --live scores the recorded live verdicts; it takes no --adapter');
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

const CELL = 34;

// " 51.0% [45.2, 56.7]     92/180", or n/a with no denominator.
function withInterval(value: number | null, interval: Interval | null, num: number, den: number): string {
  if (value === null || interval === null) return '   n/a'.padEnd(CELL);
  const ci = `[${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;
  return `${pct(value)} ${ci.padEnd(13)} ${`${num}/${den}`.padStart(9)}`.padEnd(CELL);
}

function clearRow(m: ConfusionMatrix, verdict: 'clear_yes' | 'clear_no'): { num: number; den: number } {
  const row = m[verdict];
  return { num: row[verdict], den: row.clear_yes + row.clear_no };
}

function uncertainCounts(m: ConfusionMatrix): { num: number; den: number } {
  const total = GUARD_VERDICTS.reduce((sum, v) => sum + m[v].clear_yes + m[v].clear_no, 0);
  return { num: m.uncertain.clear_yes + m.uncertain.clear_no, den: total };
}

function printMatrix(m: ConfusionMatrix): void {
  console.log('\nConfusion matrix (rows: guard verdict, columns: parent label; clear_no = unsafe)');
  console.log(`  ${''.padEnd(12)}${HUMAN_LABELS.map((l) => l.padStart(11)).join('')}${'total'.padStart(8)}`);
  for (const v of GUARD_VERDICTS) {
    const row = m[v];
    const total = row.clear_yes + row.clear_no;
    console.log(`  ${v.padEnd(12)}${HUMAN_LABELS.map((l) => String(row[l]).padStart(11)).join('')}${String(total).padStart(8)}`);
  }
}

function printExcluded(s: SafetyScore): void {
  const safety = s.scored - s.excluded.notForUs - s.excluded.unrecorded;
  console.log(`  safety labels (allow, unsafe)       ${String(safety).padStart(5)}`);
  console.log(`  not for us (excluded)               ${String(s.excluded.notForUs).padStart(5)}`);
  console.log(`  block, kind not recorded (excluded) ${String(s.excluded.unrecorded).padStart(5)}`);
}

async function recover(args: Args): Promise<number> {
  const r = await recoverInputs(config.DATABASE_PATH, { force: args.force });
  const line = (label: string, n: number) => console.log(`  ${label.padEnd(44)} ${String(n).padStart(5)}`);
  console.log(`Recovered inputs: ${r.recoveredPath}`);
  console.log(`Decided candidates with no candidate_pool row:  ${String(r.missing).padStart(5)}`);
  line('already recovered (skipped)', r.alreadyHad);
  line('no YouTube id on the decision', r.noYoutubeId);
  line('recovered this run', r.recovered);
  line('unavailable (private, deleted or removed)', r.unavailable);
  if (r.stoppedBy) {
    line('not attempted (stopped early)', r.notAttempted);
    console.log(r.stoppedBy.quotaExceeded
      ? 'Stopped: Data API quota exceeded. What was fetched is saved; re-run tomorrow to resume.'
      : `Stopped: ${r.stoppedBy.message}. What was fetched is saved; re-run to resume.`);
    return 1;
  }
  return 0;
}

function snapshot(): void {
  const r = snapshotToFile(config.DATABASE_PATH);
  const s = summariseDataset(r.items);
  console.log(`Dataset: ${r.datasetPath}`);
  console.log(`Decisions read:       ${r.decisions}`);
  console.log(`Dropped:              ${r.decisions - r.items.length}`);
  printCounts('Dropped by reason (subject_missing: no row and nothing recovered)', r.dropped);
  console.log(`Items written:        ${s.total}`);
  console.log(`Holdout (~${HOLDOUT_PERCENT}%):        ${s.holdout}`);
  console.log(`Revised labels:       ${s.revised}`);
  printCounts('By label', s.byLabel);
  printCounts('Blocks by kind', s.byBlockKind);
  printCounts('By subject type', s.bySubjectType);
  printCounts('By inputs', s.byInputs);
}

function datasetPath(args: Args): string {
  return args.dataset ? path.resolve(args.dataset) : latestDatasetPath(config.DATABASE_PATH);
}

async function run(args: Args): Promise<number> {
  const adapter = await getAdapter(args.adapter);
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

const SPLITS = SPLIT_NAMES;
const SPLIT_LABELS: Record<(typeof SPLIT_NAMES)[number], string> = {
  holdout: 'holdout',
  nonHoldout: 'non-holdout',
  original: 'inputs: original',
  recovered: 'inputs: recovered',
};

function segmentHeader(extra: string): void {
  console.log(`  ${'segment'.padEnd(22)}${'scored'.padStart(7)}  ${'clear-yes precision'.padEnd(CELL)}${'clear-no precision'.padEnd(CELL)}${extra}`);
}

function segmentCells(name: string, s: SafetyScore): string {
  const cy = clearRow(s.matrix, 'clear_yes');
  const cn = clearRow(s.matrix, 'clear_no');
  return `  ${name.padEnd(22)}${String(s.scored).padStart(7)}  `
    + withInterval(s.metrics.clearYesPrecision, s.intervals.clearYesPrecision, cy.num, cy.den)
    + withInterval(s.metrics.clearNoPrecision, s.intervals.clearNoPrecision, cn.num, cn.den);
}

async function adapterReport(args: Args): Promise<void> {
  const adapter = await getAdapter(args.adapter);
  const file = datasetPath(args);
  const r = reportForAdapter(readDataset(file), readResults(resultsPathFor(file)), adapter.id);
  console.log(`Dataset: ${path.basename(file)}`);
  console.log(`Adapter: ${r.adapterId}`);
  console.log(`Scored:  ${r.scored} of ${r.datasetItems} items`);
  printExcluded(r);
  printMatrix(r.matrix);
  const m = r.metrics;
  const i = r.intervals;
  const t = THRESHOLDS;
  const cy = clearRow(r.matrix, 'clear_yes');
  const cn = clearRow(r.matrix, 'clear_no');
  const un = uncertainCounts(r.matrix);
  console.log(`\n${'Metric (Wilson 95% interval)'.padEnd(23 + CELL)}  target`);
  console.log(`  clear-yes precision  ${withInterval(m.clearYesPrecision, i.clearYesPrecision, cy.num, cy.den)}  >= ${t.clearYesPrecision * 100}%   miss: guard approved, parent said unsafe`);
  console.log(`  clear-no precision   ${withInterval(m.clearNoPrecision, i.clearNoPrecision, cn.num, cn.den)}  >= ${t.clearNoPrecision * 100}%   miss: guard rejected, parent allowed`);
  console.log(`  uncertain rate       ${withInterval(m.uncertainRate, i.uncertainRate, un.num, un.den)}  ${t.uncertainRate.min * 100}-${t.uncertainRate.max * 100}%`);

  console.log('\nBy split (Wilson 95% intervals)');
  segmentHeader('uncertain rate');
  const segments: Array<[string, SafetyScore]> = [['overall', r], ...SPLITS.map((k): [string, SafetyScore] => [SPLIT_LABELS[k], r.splits[k]])];
  for (const [name, s] of segments) {
    const u = uncertainCounts(s.matrix);
    console.log(segmentCells(name, s) + withInterval(s.metrics.uncertainRate, s.intervals.uncertainRate, u.num, u.den));
  }
}

function liveLine(name: string, s: LiveScore): string {
  const c = s.conservativeClearYes;
  return segmentCells(name, s)
    + withInterval(c.precision, c.interval, c.allowed, c.allowed + c.blocked)
    + `${String(s.excluded.notForUs).padStart(6)}${String(s.excluded.unrecorded).padStart(8)}`;
}

function liveReportCommand(args: Args): void {
  const file = datasetPath(args);
  const r = liveReport(readDataset(file));
  console.log(`Dataset: ${path.basename(file)}`);
  console.log('Verdicts: the live guard verdict each decision recorded (no model calls)');
  console.log(`Items:    ${r.datasetItems}; no live verdict recorded (left out): ${r.noLiveVerdict}`);
  printExcluded(r.overall);
  printMatrix(r.overall.matrix);

  console.log('\nPrecision for clear verdicts only, with Wilson 95% intervals. "All Blocks as misses" is');
  console.log('clear-yes precision if every Block, any kind and unrecorded included, counted as a miss:');
  console.log('a floor on precision (an upper bound on misses) while most Blocks carry no kind.');
  const header = () => segmentHeader(`${'clear-yes, all Blocks as misses'.padEnd(CELL)}${'nfu'.padStart(6)}${'unrec'.padStart(8)}`);
  header();
  console.log(liveLine('overall', r.overall));
  for (const k of SPLITS) console.log(liveLine(SPLIT_LABELS[k], r[k]));
  console.log('\nBy prompt family (live prompt version, through the decision\'s eval row)');
  header();
  for (const [k, s] of Object.entries(r.byPromptFamily)) console.log(liveLine(k, s));
  console.log('\nBy label source');
  header();
  for (const [k, s] of Object.entries(r.byLabelSource)) console.log(liveLine(k, s));

  console.log('\nThe uncertain rate cannot be read from decisions: every escalation is decided, but clear');
  console.log('verdicts are only sampled. Instead, the rate per prompt version over every verdict');
  console.log(`recorded in guard_eval in the last ${LIVE_UNCERTAIN_DAYS} days. Not live traffic alone: offline`);
  console.log('re-runs (guard:rerun-parked) write there under the same prompt versions and cannot be');
  console.log('told apart, so a backlog re-run moves this figure without any live verdict changing.');
  const rates = liveUncertainRatesFromFile(config.DATABASE_PATH);
  if (rates.length === 0) console.log('  no guard verdicts in that window');
  for (const u of rates) {
    console.log(`  ${(u.promptVersion ?? 'unknown').padEnd(42)}${withInterval(u.rate, u.interval, u.uncertain, u.total)}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'recover') return recover(args);
  if (args.command === 'snapshot') {
    snapshot();
    return 0;
  }
  if (args.command === 'run') return run(args);
  if (args.live) liveReportCommand(args);
  else await adapterReport(args);
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
