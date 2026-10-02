import { describe, expect, it, vi } from 'vitest';

// reportForAdapter on synthetic items and results: the safety metrics count
// only Unsafe Blocks as clear-no (#227).

vi.mock('../../db/client', () => {
  throw new Error('src/db/client.ts must not be imported by the report path');
});

vi.mock('../../config', () => ({
  config: { OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

import { reportForAdapter, type HarnessItem, type HarnessResult } from './index';
import type { BlockKind, HumanLabel } from './util';

function item(id: string, label: HumanLabel, blockKind: BlockKind | null): HarnessItem {
  return {
    itemId: id, subjectType: 'candidate', subjectId: `c-${id}`, userId: 'kid_1', label,
    firstPassLabel: label, revisedAt: null, blockKind, decisionSource: 'spot_check', rubricVersion: 'rubric-v1.3',
    guardVerdict: 'clear_yes', decidedAt: '2026-09-20T12:00:00.000Z', holdout: false, ageBand: '10-12',
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
  });
});
