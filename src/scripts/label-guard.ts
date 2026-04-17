#!/usr/bin/env tsx
/**
 * npm run label-guard
 *
 * Iterates unlabelled guard_eval rows, shows Gemma's verdict + reasoning,
 * and records the human verdict. Builds the eval dataset for Phase 6 tuning.
 *
 * Keys: a=approve(clear_yes)  d=deny(clear_no)  u=uncertain  s=skip  q=quit
 * If you disagree with Gemma's verdict, press the key for the correct verdict.
 * If you agree, press the same key as Gemma's verdict.
 */
import 'dotenv/config';
import * as readline from 'readline/promises';
import { db } from '../db/client';

interface EvalRow {
  eval_id: string;
  request_id: string | null;
  url: string;
  title: string | null;
  channel: string | null;
  gemma_verdict: string | null;
  gemma_reason: string | null;
  gemma_confidence: number | null;
  scored_at: string | null;
  created_at: string;
}

const VERDICT_KEYS: Record<string, string> = { a: 'clear_yes', d: 'clear_no', u: 'uncertain' };

function verdictLabel(v: string | null): string {
  if (v === 'clear_yes') return 'CLEAR YES ✓';
  if (v === 'clear_no') return 'CLEAR NO ✗';
  if (v === 'uncertain') return 'UNCERTAIN ?';
  return v ?? 'unknown';
}

async function main(): Promise<void> {
  const rows = db.prepare(`
    SELECT
      ge.eval_id, ge.request_id, ge.url,
      r.title, r.channel,
      ge.gemma_verdict, ge.gemma_reason, ge.gemma_confidence,
      ge.scored_at, ge.created_at
    FROM guard_eval ge
    LEFT JOIN requests r ON ge.request_id = r.request_id
    WHERE ge.human_verdict IS NULL
    ORDER BY COALESCE(ge.scored_at, ge.created_at) ASC
  `).all() as EvalRow[];

  if (rows.length === 0) {
    process.stdout.write('No unlabelled verdicts. All caught up.\n');
    return;
  }

  process.stdout.write(`\n${rows.length} unlabelled verdict(s) to review.\n`);
  process.stdout.write('Keys: a=clear_yes  d=clear_no  u=uncertain  s=skip  q=quit\n\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let labelled = 0;

  for (const row of rows) {
    const date = (row.scored_at ?? row.created_at).slice(0, 16).replace('T', ' ');
    process.stdout.write('─'.repeat(60) + '\n');
    process.stdout.write(`Date:    ${date}\n`);
    process.stdout.write(`URL:     ${row.url}\n`);
    if (row.title) process.stdout.write(`Title:   ${row.title}\n`);
    if (row.channel) process.stdout.write(`Channel: ${row.channel}\n`);
    process.stdout.write(`Gemma:   ${verdictLabel(row.gemma_verdict)}`);
    if (row.gemma_confidence !== null) {
      process.stdout.write(` (confidence: ${(row.gemma_confidence * 100).toFixed(0)}%)`);
    }
    process.stdout.write('\n');
    if (row.gemma_reason) process.stdout.write(`Reason:  ${row.gemma_reason}\n`);
    process.stdout.write('\n');

    let key: string | null = null;
    while (key === null) {
      const answer = (await rl.question('Your verdict [a/d/u/s/q]: ')).trim().toLowerCase();
      if (answer === 'q') {
        process.stdout.write(`\nLabelled ${labelled} verdict(s). Quitting.\n`);
        rl.close();
        return;
      }
      if (answer === 's') {
        key = 's';
      } else if (VERDICT_KEYS[answer]) {
        key = answer;
      } else {
        process.stdout.write('Invalid key. Use a, d, u, s, or q.\n');
      }
    }

    if (key === 's') {
      process.stdout.write('Skipped.\n\n');
      continue;
    }

    const humanVerdict = VERDICT_KEYS[key]!;
    let notes: string | null = null;

    if (humanVerdict !== row.gemma_verdict) {
      notes = (await rl.question('Note on disagreement (optional, enter to skip): ')).trim() || null;
    }

    db.prepare(`
      UPDATE guard_eval
      SET human_verdict = @human_verdict, human_notes = @notes, human_labelled_at = @now
      WHERE eval_id = @eval_id
    `).run({
      human_verdict: humanVerdict,
      notes,
      now: new Date().toISOString(),
      eval_id: row.eval_id,
    });

    labelled++;
    const agree = humanVerdict === row.gemma_verdict;
    process.stdout.write(`Saved: ${verdictLabel(humanVerdict)}${agree ? ' (agree)' : ' (disagree)'}\n\n`);
  }

  rl.close();
  process.stdout.write(`Done. Labelled ${labelled} verdict(s).\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`label-guard failed: ${String(err)}\n`);
  process.exit(1);
});
