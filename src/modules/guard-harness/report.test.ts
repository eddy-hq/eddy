import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// reportForAdapter and liveReport on synthetic items and results: the safety
// metrics count only Unsafe Blocks as clear-no (#227), and every figure is
// also split by holdout and by inputs.

vi.mock('../../db/client', () => {
  throw new Error('src/db/client.ts must not be imported by the report path');
});

vi.mock('../../config', () => ({
  config: { OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

import {
  liveReport,
  liveUncertainRates,
  promptFamily,
  reportForAdapter,
  RUBRIC_FAMILY,
  type HarnessItem,
  type HarnessResult,
} from './index';
import type { BlockKind, HumanLabel, ItemInputs } from './util';

function item(id: string, label: HumanLabel, blockKind: BlockKind | null, opts: {
  holdout?: boolean; inputs?: ItemInputs; guardVerdict?: string | null; livePromptVersion?: string | null;
  decisionSource?: string;
} = {}): HarnessItem {
  return {
    itemId: id, subjectType: 'candidate', subjectId: `c-${id}`, userId: 'kid_1', label,
    firstPassLabel: label, revisedAt: null, blockKind, decisionSource: opts.decisionSource ?? 'spot_check',
    rubricVersion: 'rubric-v1.3',
    guardVerdict: opts.guardVerdict === undefined ? 'clear_yes' : opts.guardVerdict,
    livePromptVersion: opts.livePromptVersion ?? null, inputs: opts.inputs ?? 'original',
    decidedAt: '2026-09-20T12:00:00.000Z', holdout: opts.holdout ?? false, ageBand: '10-12',
    title: 'Placeholder title', channel: 'Placeholder channel', description: null, tags: [], categoryId: null,
    madeForKids: null, ageRestricted: false, channelHistory: null,
  };
}

function result(itemId: string, verdict: HarnessResult['verdict']): HarnessResult {
  return { adapterId: 'stub', itemId, verdict, durationMs: 1, evaluatedAt: '2026-10-02T08:00:00.000Z' };
}

describe('reportForAdapter', () => {
  it('scores safety on Allow and Unsafe labels, and counts Not for us and unrecorded Blocks apart', () => {
    const items = [
      item('allow', 'clear_yes', null),
      item('unsafe', 'clear_no', 'unsafe'),
      item('nfu', 'clear_no', 'not_for_us'),
      item('old', 'clear_no', null),
      // No result for this adapter: not scored, not counted.
      item('unrun', 'clear_no', 'not_for_us'),
    ];
    const results = [
      result('allow', 'clear_yes'), result('unsafe', 'clear_yes'),
      result('nfu', 'clear_yes'), result('old', 'clear_yes'),
    ];
    const r = reportForAdapter(items, results, 'stub');
    expect(r.datasetItems).toBe(5);
    expect(r.scored).toBe(4);
    expect(r.excluded).toEqual({ notForUs: 1, unrecorded: 1 });
    // Guard approved twice; the parent said unsafe once.
    expect(r.matrix.clear_yes).toEqual({ clear_yes: 1, clear_no: 1 });
    expect(r.metrics.clearYesPrecision).toBeCloseTo(0.5);
    expect(r.intervals.clearYesPrecision!.low).toBeLessThan(0.5);
    expect(r.intervals.clearYesPrecision!.high).toBeGreaterThan(0.5);
  });

  it('splits by holdout and by inputs alongside the overall figures', () => {
    const items = [
      item('h-allow', 'clear_yes', null, { holdout: true }),
      item('h-unsafe', 'clear_no', 'unsafe', { holdout: true, inputs: 'recovered' }),
      item('n-allow', 'clear_yes', null),
      item('n-allow-2', 'clear_yes', null, { inputs: 'recovered' }),
    ];
    const results = items.map((i) => result(i.itemId, 'clear_yes'));
    const r = reportForAdapter(items, results, 'stub');
    expect(r.metrics.clearYesPrecision).toBeCloseTo(0.75);
    expect(r.splits.holdout.scored).toBe(2);
    expect(r.splits.holdout.metrics.clearYesPrecision).toBeCloseTo(0.5);
    expect(r.splits.nonHoldout.metrics.clearYesPrecision).toBe(1);
    expect(r.splits.original.scored).toBe(2);
    expect(r.splits.original.metrics.clearYesPrecision).toBe(1);
    expect(r.splits.recovered.metrics.clearYesPrecision).toBeCloseTo(0.5);
  });
});

describe('liveReport', () => {
  it('scores the recorded live verdict, with a conservative clear-yes line counting every Block as a miss', () => {
    const items = [
      item('allow', 'clear_yes', null),
      item('allow-2', 'clear_yes', null),
      item('unsafe', 'clear_no', 'unsafe'),
      item('nfu', 'clear_no', 'not_for_us'),
      item('old', 'clear_no', null),
      item('rejected-unsafe', 'clear_no', 'unsafe', { guardVerdict: 'clear_no' }),
      item('escalated', 'clear_yes', null, { guardVerdict: 'uncertain', decisionSource: 'escalation' }),
      item('none', 'clear_yes', null, { guardVerdict: null }),
    ];
    const r = liveReport(items);
    expect(r.datasetItems).toBe(8);
    expect(r.noLiveVerdict).toBe(1);
    expect(r.overall.scored).toBe(7);
    expect(r.overall.excluded).toEqual({ notForUs: 1, unrecorded: 1 });
    expect(r.overall.matrix.clear_yes).toEqual({ clear_yes: 2, clear_no: 1 });
    expect(r.overall.metrics.clearYesPrecision).toBeCloseTo(2 / 3);
    expect(r.overall.metrics.clearNoPrecision).toBe(1);
    // Any kind, unrecorded included: 2 allowed of 5 cleared.
    expect(r.overall.conservativeClearYes).toMatchObject({ allowed: 2, blocked: 3 });
    expect(r.overall.conservativeClearYes.precision).toBeCloseTo(0.4);
    expect(r.overall.conservativeClearYes.interval).not.toBeNull();
    expect(Object.keys(r.byLabelSource)).toEqual(['escalation', 'spot_check']);
    expect(r.byLabelSource['escalation']!.matrix.uncertain.clear_yes).toBe(1);
  });

  it('groups prompt versions containing v4 as the rubric family, the rest by version', () => {
    expect(promptFamily('candidate-v4.1')).toBe(RUBRIC_FAMILY);
    expect(promptFamily('candidate-transcript-v4.1-no-transcript')).toBe(RUBRIC_FAMILY);
    expect(promptFamily('candidate-v3')).toBe('candidate-v3');
    expect(promptFamily(null)).toBe('unknown');
    const r = liveReport([
      item('a', 'clear_yes', null, { livePromptVersion: 'candidate-v4' }),
      item('b', 'clear_no', 'unsafe', { livePromptVersion: 'candidate-v4.1' }),
      item('c', 'clear_yes', null, { livePromptVersion: 'candidate-v3' }),
      item('d', 'clear_yes', null),
    ]);
    expect(Object.keys(r.byPromptFamily)).toEqual(['candidate-v3', 'unknown', RUBRIC_FAMILY]);
    expect(r.byPromptFamily[RUBRIC_FAMILY]!.metrics.clearYesPrecision).toBeCloseTo(0.5);
  });

  it('splits by holdout and inputs', () => {
    const r = liveReport([
      item('a', 'clear_yes', null, { holdout: true }),
      item('b', 'clear_no', 'unsafe', { inputs: 'recovered' }),
    ]);
    expect(r.holdout.scored).toBe(1);
    expect(r.nonHoldout.scored).toBe(1);
    expect(r.original.metrics.clearYesPrecision).toBe(1);
    expect(r.recovered.metrics.clearYesPrecision).toBe(0);
  });
});

describe('liveUncertainRates', () => {
  it('counts uncertain verdicts per prompt version over the last 14 days, offline re-runs included', () => {
    const db = new Database(':memory:');
    try {
      const migrations = path.join(__dirname, '../../db/migrations');
      for (const f of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) {
        db.exec(readFileSync(path.join(migrations, f), 'utf8'));
      }
      const insert = db.prepare(`
        INSERT INTO guard_eval (eval_id, url, gemma_verdict, prompt_version, created_at)
        VALUES (?, 'https://example.invalid/x', ?, ?, ?)
      `);
      const now = new Date('2026-10-18T12:00:00.000Z');
      insert.run('e1', 'uncertain', 'candidate-v4.1', '2026-10-17T12:00:00.000Z');
      insert.run('e2', 'clear_yes', 'candidate-v4.1', '2026-10-10T12:00:00.000Z');
      insert.run('e3', 'clear_yes', 'candidate-v4.1', '2026-10-05T12:00:00.000Z');
      insert.run('e4', 'clear_yes', 'candidate-v4.1', '2026-10-04T13:00:00.000Z');
      // Older than 14 days: left out.
      insert.run('e5', 'uncertain', 'candidate-v4.1', '2026-10-03T12:00:00.000Z');
      insert.run('e6', 'uncertain', 'v2', '2026-10-17T12:00:00.000Z');
      const rates = liveUncertainRates(db, now);
      expect(rates.map((r) => [r.promptVersion, r.total, r.uncertain])).toEqual([
        ['candidate-v4.1', 4, 1], ['v2', 1, 1],
      ]);
      expect(rates[0]!.rate).toBeCloseTo(0.25);
      expect(rates[0]!.interval!.low).toBeLessThan(0.25);

      // An offline re-run (guard:rerun-parked) writes a row shaped exactly
      // like a live candidate verdict, so it is counted: the CLI labels the
      // figure as every recorded verdict, not live traffic alone.
      db.prepare(`
        INSERT INTO guard_eval (eval_id, url, gemma_verdict, prompt_version, request_type, user_id, candidate_id, created_at)
        VALUES ('e-rerun', 'https://example.invalid/x', 'uncertain', 'candidate-v4.1', 'candidate', 'kid_1', 'c-parked', ?)
      `).run('2026-10-18T06:00:00.000Z');
      expect(liveUncertainRates(db, now)[0]).toMatchObject({ promptVersion: 'candidate-v4.1', total: 5, uncertain: 2 });
    } finally {
      db.close();
    }
  });
});
