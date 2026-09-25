#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run guard:rerun-parked [-- --prompt v3|v4] [--limit N]
 *                            [--sample N [--seed S]] [--population pending|decided]
 *                            [--concurrency N]
 * npm run guard:rerun-parked -- --apply [--prompt v3|v4] [--force-backup]
 *
 * Re-judges the parked guard backlog (Phase 6a) with a candidate prompt and
 * stored Data API metadata.
 *
 * Default: evaluate with the live prompt (GUARD_CANDIDATE_PROMPT). Guards
 * every parked kid candidate, writing verdicts to parked-rerun.json beside the
 * DB. Resumable — candidates already in the file at the chosen prompt version
 * are skipped; other versions' entries are kept. Does not change
 * candidate_pool.
 *
 *   --prompt v3|v4       judge with this prompt instead of the live one
 *   --sample N           deterministic sample of N, stratified evenly by kid
 *   --seed S             sample seed (default fixed, so runs are repeatable)
 *   --population decided sample candidates the guard already decided (scored
 *                        clear_yes / guard_rejected clear_no) instead of the
 *                        parked ones, into parked-rerun-decided.json — to check
 *                        a prompt doesn't flip an earlier clear_no to clear_yes
 *   --concurrency N      guard calls in flight, 1-4 (default 1)
 *
 * --apply: backs up the DB to eddy.pre-parked-rerun.db beside it, then moves
 * each still-parked candidate per its recorded verdict. Never calls the model.
 * Applies only results at the live prompt's version unless --prompt is given
 * explicitly, so v4 verdicts can't be applied by accident while v3 is live.
 *
 * Output is counts only — no titles, channels or guard reasons.
 */
import 'dotenv/config';
import path from 'node:path';
import { config } from '../config';
import { runMigrations } from '../db/migrate';
import { liveCandidatePrompt, rerunVersionKey } from '../modules/guard/index';
import {
  evaluateParkedBacklog,
  applyParkedRerun,
  parseRerunArgs,
  readRerunResults,
  resolveRerunPrompt,
  summariseRerun,
  ParkedRerunError,
  type ParkedRerunSummary,
} from '../modules/discovery/index';

function printCounts(title: string, counts: Record<string, number>): void {
  console.log(`  ${title}`);
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) console.log('    (none)');
  for (const k of keys) console.log(`    ${k.padEnd(32)} ${String(counts[k]).padStart(5)}`);
}

function printSummary(s: ParkedRerunSummary): void {
  console.log(`\nSummary — ${s.total} evaluated at ${s.promptVersion}`);
  if (s.clearNoToClearYes > 0) {
    console.log(`  !! ${s.clearNoToClearYes} earlier clear_no now clear_yes — check these before going live !!`);
  } else {
    console.log('  clear_no -> clear_yes: 0');
  }
  printCounts('Old -> new verdict', s.transitions);
  for (const kid of Object.keys(s.byUser).sort()) printCounts(kid, s.byUser[kid]!);
  printCounts('Candidate added <= 14 days ago', s.byCandidateAge.recent);
  printCounts('Candidate added > 14 days ago', s.byCandidateAge.older);
  if (Object.keys(s.byCandidateAge.unknown).length > 0) {
    printCounts('Candidate no longer in pool', s.byCandidateAge.unknown);
  }
  console.log(`  Age-restricted (clear_no, no model call): ${s.ageRestricted}`);
  for (const [version, n] of Object.entries(s.otherVersions).sort()) {
    console.log(`  Sample entries also evaluated at ${version}: ${n}`);
  }
  if (Object.keys(s.drivers).length > 0) printCounts('Rubric verdict drivers', s.drivers);
}

async function main(): Promise<number> {
  const args = parseRerunArgs(process.argv.slice(2));
  const live = liveCandidatePrompt();
  const prompt = resolveRerunPrompt(args, live);
  const promptVersion = rerunVersionKey(prompt);
  const dataDir = path.dirname(path.resolve(config.DATABASE_PATH));
  const resultsPath = path.join(
    dataDir,
    args.population === 'decided' ? 'parked-rerun-decided.json' : 'parked-rerun.json',
  );
  const backupPath = path.join(dataDir, 'eddy.pre-parked-rerun.db');

  runMigrations();

  if (args.apply) {
    if (prompt !== live) {
      console.log(`Applying ${promptVersion} results while the live prompt is ${rerunVersionKey(live)} (explicit --prompt).`);
    }
    const r = await applyParkedRerun({ resultsPath, backupPath, promptVersion, forceBackup: args.forceBackup });
    console.log(`Backed up DB to ${backupPath}`);
    console.log(`Applying results at:             ${r.promptVersion}`);
    console.log(`Results in file:                 ${r.results}`);
    console.log(`Applied -> scored (clear_yes):   ${r.applied.scored}`);
    console.log(`Applied -> guard_rejected:       ${r.applied.guard_rejected}`);
    console.log(`Still guard_pending (uncertain): ${r.applied.guard_pending}`);
    console.log(`Skipped, status changed:         ${r.statusChanged}`);
    if (r.otherVersion > 0) console.log(`Skipped, other prompt version:   ${r.otherVersion}`);
    return 0;
  }

  console.log(`Results file: ${resultsPath}`);
  console.log(`Prompt: ${promptVersion}${prompt === live ? ' (live)' : ` (live is ${rerunVersionKey(live)})`}`);
  let lastLine = '';
  const report = await evaluateParkedBacklog({
    resultsPath,
    prompt,
    population: args.population,
    sample: args.sample,
    seed: args.seed,
    limit: args.limit,
    concurrency: args.concurrency,
    onProgress: (done, total) => {
      const line = `${done}/${total}`;
      if (line !== lastLine) {
        process.stdout.write(`\r  ${line}`);
        lastLine = line;
      }
    },
  });
  if (lastLine) process.stdout.write('\n');

  const label = args.population === 'decided' ? 'Decided kid candidates:' : 'Parked kid candidates:';
  console.log(`${label.padEnd(33)}${report.eligible}`);
  if (args.sample !== undefined) {
    console.log(`Sampled:                         ${report.selected}${report.sampleReused ? ' (saved sample reused)' : ' (new sample saved)'}`);
    if (report.sampleDropped > 0) {
      console.log(`Sample left the population:      ${report.sampleDropped}`);
    }
  }
  console.log(`Already evaluated (skipped):     ${report.alreadyEvaluated}`);
  console.log(`Evaluated this run:              ${report.recorded}`);
  if (report.missingMetadata > 0) {
    console.log(`No metadata (retried next run):  ${report.missingMetadata}`);
  }
  if (report.scoringErrors > 0) {
    console.log(`Model errors (retried next run): ${report.scoringErrors}`);
  }
  if (report.meanCallSeconds !== null) {
    console.log(`Mean seconds per call this run:  ${report.meanCallSeconds.toFixed(2)} (wall ${report.wallSeconds.toFixed(0)}s, concurrency ${args.concurrency})`);
  }
  if (report.abortedAfterErrors) {
    console.log('Stopped early: repeated model errors — check Ollama, then re-run to resume.');
  }

  // A --sample run summarises its sample only, so the counts compare like with like.
  const onlyIds = report.sampleIds ? new Set(report.sampleIds) : undefined;
  printSummary(summariseRerun(readRerunResults(resultsPath), promptVersion, new Date(), onlyIds));
  if (args.population === 'decided') {
    console.log('\nMeasurement only — decided candidates are never applied.');
  } else {
    console.log(`\nNothing applied. Review the summary, then run with --apply${prompt === live ? '' : ` --prompt ${prompt}`}.`);
  }
  return report.abortedAfterErrors ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err: unknown) => {
  if (err instanceof ParkedRerunError) {
    console.error(err.message);
  } else {
    console.error('Parked re-run failed:', err);
  }
  process.exit(1);
});
