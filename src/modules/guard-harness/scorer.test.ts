import { describe, expect, it } from 'vitest';
import {
  confusionMatrix,
  metricsFromMatrix,
  safetyLabel,
  scorePairs,
  scoreSafety,
  type LabelledVerdict,
  type ScoredPair,
} from './scorer';

function pairs(spec: Array<[ScoredPair['verdict'], ScoredPair['label'], number]>): ScoredPair[] {
  return spec.flatMap(([verdict, label, n]) => Array.from({ length: n }, () => ({ verdict, label })));
}

describe('confusionMatrix', () => {
  it('counts guard verdict × parent label', () => {
    const m = confusionMatrix(pairs([
      ['clear_yes', 'clear_yes', 19], ['clear_yes', 'clear_no', 1],
      ['clear_no', 'clear_no', 9], ['clear_no', 'clear_yes', 1],
      ['uncertain', 'clear_yes', 6], ['uncertain', 'clear_no', 4],
    ]));
    expect(m).toEqual({
      clear_yes: { clear_yes: 19, clear_no: 1 },
      clear_no: { clear_yes: 1, clear_no: 9 },
      uncertain: { clear_yes: 6, clear_no: 4 },
    });
  });

  it('is all zeros for no pairs', () => {
    expect(confusionMatrix([])).toEqual({
      clear_yes: { clear_yes: 0, clear_no: 0 },
      clear_no: { clear_yes: 0, clear_no: 0 },
      uncertain: { clear_yes: 0, clear_no: 0 },
    });
  });
});

describe('metrics', () => {
  it('computes the three metrics', () => {
    const { metrics } = scorePairs(pairs([
      ['clear_yes', 'clear_yes', 19], ['clear_yes', 'clear_no', 1],
      ['clear_no', 'clear_no', 9], ['clear_no', 'clear_yes', 1],
      ['uncertain', 'clear_yes', 6], ['uncertain', 'clear_no', 4],
    ]));
    expect(metrics.total).toBe(40);
    expect(metrics.clearYesPrecision).toBeCloseTo(0.95);
    expect(metrics.clearNoPrecision).toBeCloseTo(0.9);
    expect(metrics.uncertainRate).toBeCloseTo(0.25);
  });

  it('reports null when a denominator is zero', () => {
    const metrics = metricsFromMatrix(confusionMatrix(pairs([['uncertain', 'clear_yes', 3]])));
    expect(metrics).toEqual({ total: 3, clearYesPrecision: null, clearNoPrecision: null, uncertainRate: 1 });
    expect(metricsFromMatrix(confusionMatrix([]))).toEqual({
      total: 0, clearYesPrecision: null, clearNoPrecision: null, uncertainRate: null,
    });
  });

  it('a guard that only escalates has no precision but full uncertain rate', () => {
    const { metrics } = scorePairs(pairs([['uncertain', 'clear_yes', 5], ['uncertain', 'clear_no', 5]]));
    expect(metrics.uncertainRate).toBe(1);
    expect(metrics.clearYesPrecision).toBeNull();
  });
});

describe('safety scoring (#227)', () => {
  function labelled(spec: Array<[LabelledVerdict['verdict'], LabelledVerdict['label'], LabelledVerdict['blockKind'], number]>): LabelledVerdict[] {
    return spec.flatMap(([verdict, label, blockKind, n]) => Array.from({ length: n }, () => ({ verdict, label, blockKind })));
  }

  it('counts an Allow as clear-yes and only an Unsafe Block as clear-no', () => {
    expect(safetyLabel('clear_yes', null)).toBe('clear_yes');
    expect(safetyLabel('clear_no', 'unsafe')).toBe('clear_no');
    expect(safetyLabel('clear_no', 'not_for_us')).toBe('not_for_us');
    expect(safetyLabel('clear_no', null)).toBe('unrecorded');
  });

  it('leaves Not for us and unrecorded Blocks out of the metrics, and counts each', () => {
    const r = scoreSafety(labelled([
      ['clear_yes', 'clear_yes', null, 19], ['clear_yes', 'clear_no', 'unsafe', 1],
      // Guard approved, parent said not for us: a taste miss, not a safety one.
      ['clear_yes', 'clear_no', 'not_for_us', 7],
      ['clear_yes', 'clear_no', null, 3],
      ['clear_no', 'clear_no', 'unsafe', 9], ['clear_no', 'clear_yes', null, 1],
      ['clear_no', 'clear_no', 'not_for_us', 4],
      ['uncertain', 'clear_yes', null, 6], ['uncertain', 'clear_no', 'unsafe', 4],
      ['uncertain', 'clear_no', null, 2],
    ]));
    expect(r.excluded).toEqual({ notForUs: 11, unrecorded: 5 });
    expect(r.matrix).toEqual({
      clear_yes: { clear_yes: 19, clear_no: 1 },
      clear_no: { clear_yes: 1, clear_no: 9 },
      uncertain: { clear_yes: 6, clear_no: 4 },
    });
    expect(r.metrics.total).toBe(40);
    expect(r.metrics.clearYesPrecision).toBeCloseTo(0.95);
    expect(r.metrics.clearNoPrecision).toBeCloseTo(0.9);
    expect(r.metrics.uncertainRate).toBeCloseTo(0.25);
  });

  it('a dataset of only excluded Blocks has no safety metrics', () => {
    const r = scoreSafety(labelled([['clear_yes', 'clear_no', 'not_for_us', 2], ['clear_no', 'clear_no', null, 1]]));
    expect(r.excluded).toEqual({ notForUs: 2, unrecorded: 1 });
    expect(r.metrics).toEqual({ total: 0, clearYesPrecision: null, clearNoPrecision: null, uncertainRate: null });
  });
});
