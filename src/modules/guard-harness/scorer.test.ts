import { describe, expect, it } from 'vitest';
import { confusionMatrix, metricsFromMatrix, scorePairs, type ScoredPair } from './scorer';

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
