#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run guard:rerun-parked [-- --limit N]
 * npm run guard:rerun-parked -- --apply [--force-backup]
 *
 * Re-judges the parked guard backlog (Phase 6a) with the current candidate
 * prompt and stored Data API metadata.
 *
 * Default: evaluate. Guards every parked kid candidate one at a time, writing
 * verdicts to parked-rerun.json beside the DB. Resumable — candidates already
 * in the file at the current prompt version are skipped. Does not change
 * candidate_pool.
 *
 * --apply: backs up the DB to eddy.pre-parked-rerun.db beside it, then moves
 * each still-parked candidate per its recorded verdict. Never calls the model.
 *
 * Output is counts only — no titles, channels or guard reasons.
 */
import 'dotenv/config';
import path from 'node:path';
import { config } from '../config';
import { runMigrations } from '../db/migrate';
import {
  evaluateParkedBacklog,
  applyParkedRerun,
  readRerunResults,
  summariseRerun,
  ParkedRerunError,
  type ParkedRerunSummary,
} from '../modules/discovery/index';

interface Args {
  apply: boolean;
  forceBackup: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, forceBackup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force-backup') args.forceBackup = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new ParkedRerunError('--limit needs a positive integer');
      args.limit = n;
    } else {
      throw new ParkedRerunError(`Unknown argument: ${a}`);
    }
  }
  if (args.apply && args.limit !== undefined) {
    throw new ParkedRerunError('--limit applies to evaluation only, not --apply');
  }
  if (args.forceBackup && !args.apply) {
    throw new ParkedRerunError('--force-backup only makes sense with --apply');
  }
  return args;
}

function printCounts(title: string, counts: Record<string, number>): void {
  console.log(`  ${title}`);
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) console.log('    (none)');
  for (const k of keys) console.log(`    ${k.padEnd(28)} ${String(counts[k]).padStart(5)}`);
}

function printSummary(s: ParkedRerunSummary): void {
  console.log(`\nSummary — ${s.total} evaluated at the current prompt version`);
  printCounts('Old -> new verdict', s.transitions);
  for (const kid of Object.keys(s.byUser).sort()) printCounts(kid, s.byUser[kid]!);
  printCounts('Candidate added <= 14 days ago', s.byCandidateAge.recent);
  printCounts('Candidate added > 14 days ago', s.byCandidateAge.older);
  if (Object.keys(s.byCandidateAge.unknown).length > 0) {
    printCounts('Candidate no longer in pool', s.byCandidateAge.unknown);
  }
  console.log(`  Age-restricted (clear_no, no model call): ${s.ageRestricted}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.dirname(path.resolve(config.DATABASE_PATH));
  const resultsPath = path.join(dataDir, 'parked-rerun.json');
  const backupPath = path.join(dataDir, 'eddy.pre-parked-rerun.db');

  runMigrations();

  if (args.apply) {
    const r = await applyParkedRerun({ resultsPath, backupPath, forceBackup: args.forceBackup });
    console.log(`Backed up DB to ${backupPath}`);
    console.log(`Results in file:                 ${r.results}`);
    console.log(`Applied -> scored (clear_yes):   ${r.applied.scored}`);
    console.log(`Applied -> guard_rejected:       ${r.applied.guard_rejected}`);
    console.log(`Still guard_pending (uncertain): ${r.applied.guard_pending}`);
    console.log(`Skipped, status changed:         ${r.statusChanged}`);
    if (r.staleVersion > 0) console.log(`Skipped, older prompt version:   ${r.staleVersion}`);
    return 0;
  }

  console.log(`Results file: ${resultsPath}`);
  let lastLine = '';
  const report = await evaluateParkedBacklog({
    resultsPath,
    limit: args.limit,
    onProgress: (done, total) => {
      const line = `${done}/${total}`;
      if (line !== lastLine) {
        process.stdout.write(`\r  ${line}`);
        lastLine = line;
      }
    },
  });
  if (lastLine) process.stdout.write('\n');

  console.log(`Parked kid candidates:           ${report.parked}`);
  console.log(`Already evaluated (skipped):     ${report.alreadyEvaluated}`);
  console.log(`Evaluated this run:              ${report.recorded}`);
  if (report.missingMetadata > 0) {
    console.log(`No metadata (retried next run):  ${report.missingMetadata}`);
  }
  if (report.scoringErrors > 0) {
    console.log(`Model errors (retried next run): ${report.scoringErrors}`);
  }
  if (report.abortedAfterErrors) {
    console.log('Stopped early: repeated model errors — check Ollama, then re-run to resume.');
  }

  printSummary(summariseRerun(readRerunResults(resultsPath)));
  console.log('\nNothing applied. Review the summary, then run with --apply.');
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
