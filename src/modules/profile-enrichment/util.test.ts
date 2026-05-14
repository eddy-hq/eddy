import { describe, it, expect } from 'vitest';
import {
  computeTrustWeight,
  TRUST_DEFAULT,
  TRUST_COLD_START_FLOOR,
} from './util';

describe('computeTrustWeight', () => {
  it('returns the default (1.0) for zero events', () => {
    expect(computeTrustWeight(0, 0)).toBe(TRUST_DEFAULT);
  });

  it('holds at default while below the cold-start floor', () => {
    // floor is exclusive: total < FLOOR keeps default; total === FLOOR moves
    for (let total = 1; total < TRUST_COLD_START_FLOOR; total++) {
      expect(computeTrustWeight(total, 0)).toBe(TRUST_DEFAULT);
      expect(computeTrustWeight(0, total)).toBe(TRUST_DEFAULT);
    }
  });

  it('returns 1.5 when every event in the sample is a watch', () => {
    expect(computeTrustWeight(10, 0)).toBe(1.5);
  });

  it('returns 0.5 when every event in the sample is a dismiss', () => {
    expect(computeTrustWeight(0, 10)).toBe(0.5);
  });

  it('returns 1.0 for an even split above the floor', () => {
    expect(computeTrustWeight(5, 5)).toBe(1.0);
  });

  it('moves to 0.5 + ratio at the floor sample size', () => {
    // 4 watched + 1 dismissed = 5 total = at floor → 0.5 + 4/5 = 1.3
    expect(computeTrustWeight(4, 1)).toBe(1.3);
  });

  it('stays within the 0.5–1.5 band', () => {
    for (const [w, d] of [[100, 0], [0, 100], [73, 27], [1, 99]] as const) {
      const out = computeTrustWeight(w, d);
      expect(out).toBeGreaterThanOrEqual(0.5);
      expect(out).toBeLessThanOrEqual(1.5);
    }
  });
});
