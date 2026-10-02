import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readResults, runHarness } from './runner';
import {
  AdapterScoringError,
  GuardHarnessError,
  inDiscoveryWindow,
  resultsPathFor,
  type HarnessAdapter,
  type HarnessItem,
} from './util';

// Runner and harness helpers on synthetic items; the adapter is a stub.

function at(hours: number, minutes: number): Date {
  const d = new Date(2026, 9, 2, hours, minutes, 0);
  return d;
}

const OUTSIDE = () => at(8, 0);

function item(id: string): HarnessItem {
  return {
    itemId: id, subjectType: 'candidate', subjectId: `c-${id}`, userId: 'kid_1', label: 'clear_yes',
    firstPassLabel: 'clear_yes', revisedAt: null, blockKind: null, decisionSource: 'escalation', rubricVersion: 'rubric-v1.3', guardVerdict: 'uncertain',
    decidedAt: '2026-09-20T12:00:00.000Z', holdout: false, ageBand: '10-12', title: 'Placeholder title',
    channel: 'Placeholder channel', description: null, tags: [], categoryId: null, madeForKids: null,
    ageRestricted: false, channelHistory: null,
  };
}

function stub(judge: HarnessAdapter['judge'], id = 'stub-adapter'): HarnessAdapter {
  return { id, judge: vi.fn(judge) };
}

let dir: string;
let resultsPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'guard-harness-'));
  resultsPath = path.join(dir, 'results-2026-10-02.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discovery windows', () => {
  it('covers 05:45–07:00, 09:45–11:00 and 13:45–15:00 local, end exclusive', () => {
    expect(inDiscoveryWindow(at(5, 44))).toBe(false);
    expect(inDiscoveryWindow(at(5, 45))).toBe(true);
    expect(inDiscoveryWindow(at(6, 59))).toBe(true);
    expect(inDiscoveryWindow(at(7, 0))).toBe(false);
    expect(inDiscoveryWindow(at(10, 30))).toBe(true);
    expect(inDiscoveryWindow(at(14, 0))).toBe(true);
    expect(inDiscoveryWindow(at(15, 0))).toBe(false);
    expect(inDiscoveryWindow(at(22, 0))).toBe(false);
  });

  it('refuses to start inside a window unless forced', async () => {
    const adapter = stub(async () => ({ verdict: 'clear_yes' }));
    await expect(runHarness({ items: [item('a')], adapter, resultsPath, now: () => at(6, 0) }))
      .rejects.toBeInstanceOf(GuardHarnessError);
    expect(adapter.judge).not.toHaveBeenCalled();
    const r = await runHarness({ items: [item('a')], adapter, resultsPath, now: () => at(6, 0), force: true });
    expect(r.evaluated).toBe(1);
  });
});

describe('runHarness', () => {
  it('caches results and resumes, keyed by adapter and item', async () => {
    const items = ['a', 'b', 'c'].map(item);
    const first = stub(async () => ({ verdict: 'uncertain', scores: { violence: 1 } }));
    const r1 = await runHarness({ items, adapter: first, resultsPath, limit: 2, now: OUTSIDE });
    expect(r1).toMatchObject({ datasetItems: 3, alreadyEvaluated: 0, selected: 2, evaluated: 2 });

    const r2 = await runHarness({ items, adapter: first, resultsPath, now: OUTSIDE });
    expect(r2).toMatchObject({ alreadyEvaluated: 2, selected: 1, evaluated: 1 });
    expect(first.judge).toHaveBeenCalledTimes(3);

    // Another adapter has its own cache entries in the same file.
    const other = stub(async () => ({ verdict: 'clear_no' }), 'other-adapter');
    const r3 = await runHarness({ items, adapter: other, resultsPath, now: OUTSIDE });
    expect(r3).toMatchObject({ alreadyEvaluated: 0, evaluated: 3 });

    const results = readResults(resultsPath);
    expect(results).toHaveLength(6);
    expect(results.find((r) => r.adapterId === 'stub-adapter' && r.itemId === 'a'))
      .toMatchObject({ verdict: 'uncertain', scores: { violence: 1 } });
  });

  it('writes ids, verdicts and numbers only', async () => {
    await runHarness({ items: [item('a')], adapter: stub(async () => ({ verdict: 'clear_yes' })), resultsPath, now: OUTSIDE });
    const keys = Object.keys(JSON.parse(readFileSync(resultsPath, 'utf8').trim()) as object).sort();
    expect(keys).toEqual(['adapterId', 'durationMs', 'evaluatedAt', 'itemId', 'verdict']);
  });

  it('does not cache a model failure, and stops after repeated ones', async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`i${i}`));
    const failing = stub(async () => { throw new AdapterScoringError('no answer'); });
    const r = await runHarness({ items, adapter: failing, resultsPath, now: OUTSIDE });
    expect(r).toMatchObject({ evaluated: 0, scoringErrors: 5, abortedAfterErrors: true });
    expect(readResults(resultsPath)).toHaveLength(0);
  });

  it('propagates unexpected errors', async () => {
    const broken = stub(async () => { throw new Error('bug'); });
    await expect(runHarness({ items: [item('a')], adapter: broken, resultsPath, now: OUTSIDE })).rejects.toThrow('bug');
  });

  it('tolerates a torn last line from a killed run', async () => {
    writeFileSync(resultsPath, `${JSON.stringify({ adapterId: 'stub-adapter', itemId: 'a', verdict: 'clear_yes', durationMs: 1, evaluatedAt: 'x' })}\n{"adapterId":"stub`);
    expect(readResults(resultsPath)).toHaveLength(1);

    // Resuming cuts the torn line off before appending.
    const r = await runHarness({ items: [item('a'), item('b')], adapter: stub(async () => ({ verdict: 'clear_no' })), resultsPath, now: OUTSIDE });
    expect(r).toMatchObject({ alreadyEvaluated: 1, evaluated: 1 });
    expect(readResults(resultsPath).map((x) => x.itemId)).toEqual(['a', 'b']);
  });
});

describe('resultsPathFor', () => {
  it('sits beside its dataset', () => {
    expect(resultsPathFor('/data/harness/dataset-2026-10-02.jsonl')).toBe('/data/harness/results-dataset-2026-10-02.jsonl');
  });

  it('gives every dataset name its own cache, never the dataset itself', () => {
    const names = ['baseline.jsonl', 'dataset-baseline.jsonl', 'dataset-2026-10-02.jsonl'];
    const caches = names.map((n) => resultsPathFor(`/data/harness/${n}`));
    expect(new Set(caches).size).toBe(names.length);
    for (const n of names) expect(caches).not.toContain(`/data/harness/${n}`);
    // A results-* name could be another dataset's cache.
    expect(() => resultsPathFor('/data/harness/results-baseline.jsonl')).toThrow(GuardHarnessError);
  });

  it('a custom-named dataset runs without touching the dataset file', async () => {
    const datasetPath = path.join(dir, 'baseline.jsonl');
    const content = `${JSON.stringify(item('a'))}`;
    writeFileSync(datasetPath, content);
    await runHarness({
      items: [item('a')], adapter: stub(async () => ({ verdict: 'clear_yes' })),
      resultsPath: resultsPathFor(datasetPath), now: OUTSIDE,
    });
    expect(readFileSync(datasetPath, 'utf8')).toBe(content);
    expect(readResults(resultsPathFor(datasetPath))).toHaveLength(1);
  });
});
