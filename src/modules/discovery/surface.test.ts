import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  freshnessMultiplier,
  rankWeight,
  titleTokens,
  jaccardSimilarity,
  allocateSlots,
  type AllocatableItem,
} from './surface';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../db/client', () => ({
  db: { prepare: vi.fn() },
}));

const NOW = '2026-04-25T12:00:00.000Z';

describe('freshnessMultiplier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('news decays fast over the first month', () => {
    expect(freshnessMultiplier('2026-04-25T00:00:00.000Z', 'news')).toBe(1.6); // ~0d
    expect(freshnessMultiplier('2026-04-20T12:00:00.000Z', 'news')).toBe(0.6); // 5d
    expect(freshnessMultiplier('2026-03-26T12:00:00.000Z', 'news')).toBe(0.2); // 30d
    expect(freshnessMultiplier('2025-12-25T12:00:00.000Z', 'news')).toBeLessThanOrEqual(0.1);
  });

  it('evergreen stays nearly flat across the year', () => {
    expect(freshnessMultiplier('2026-04-25T00:00:00.000Z', 'evergreen')).toBe(1.4);
    expect(freshnessMultiplier('2026-03-26T12:00:00.000Z', 'evergreen')).toBe(1.1);
    expect(freshnessMultiplier('2025-05-01T12:00:00.000Z', 'evergreen')).toBe(1.0);
    expect(freshnessMultiplier('2024-01-01T12:00:00.000Z', 'evergreen')).toBe(0.9);
  });

  it('standard sits between news and evergreen', () => {
    expect(freshnessMultiplier('2026-04-25T00:00:00.000Z', 'standard')).toBe(1.6);
    expect(freshnessMultiplier('2026-04-19T12:00:00.000Z', 'standard')).toBe(1.2); // 6d
    expect(freshnessMultiplier('2025-12-25T12:00:00.000Z', 'standard')).toBe(0.4); // >90d
  });

  it('falls back per kind when published_at is null', () => {
    expect(freshnessMultiplier(null, 'news')).toBe(0.5);
    expect(freshnessMultiplier(null, 'evergreen')).toBe(1.0);
    expect(freshnessMultiplier(null, 'standard')).toBe(0.8);
    expect(freshnessMultiplier(null, null)).toBe(0.8); // unknown kind → standard fallback
  });
});

describe('rankWeight', () => {
  it('returns 1 for rank 1', () => {
    expect(rankWeight(1)).toBe(1);
  });

  it('returns 1/2 for rank 4', () => {
    expect(rankWeight(4)).toBe(0.5);
  });

  it('clamps rank ≤ 0 to rank 1', () => {
    expect(rankWeight(0)).toBe(1);
    expect(rankWeight(-3)).toBe(1);
  });
});

describe('titleTokens', () => {
  it('lowercases, strips punctuation, drops short tokens and stopwords', () => {
    const tokens = titleTokens("How to Build a Real-Time Chat App!");
    expect(tokens).toEqual(new Set(['build', 'real', 'time', 'chat', 'app']));
    expect(tokens.has('how')).toBe(false);
    expect(tokens.has('to')).toBe(false); // length < 3
    expect(tokens.has('a')).toBe(false); // length < 3
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  it('returns intersection / union for partial overlap', () => {
    // {a,b,c} ∩ {b,c,d} = {b,c}; union = {a,b,c,d}; 2/4 = 0.5
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });
});

describe('allocateSlots', () => {
  function item(
    overrides: Partial<AllocatableItem> & { candidateId: string; weighted: number },
  ): AllocatableItem {
    return {
      candidateId: overrides.candidateId,
      title: overrides.title ?? `title-${overrides.candidateId}`,
      interestId: overrides.interestId ?? null,
      rank: overrides.rank ?? 1,
      weighted: overrides.weighted,
    };
  }

  it('honours the per-interest cap (adult = 2)', () => {
    const ranked: AllocatableItem[] = [
      item({ candidateId: 'a', interestId: 'i1', rank: 1, weighted: 10, title: 'alpha one' }),
      item({ candidateId: 'b', interestId: 'i1', rank: 1, weighted: 9, title: 'beta two' }),
      item({ candidateId: 'c', interestId: 'i1', rank: 1, weighted: 8, title: 'gamma three' }),
      item({ candidateId: 'd', interestId: 'i2', rank: 2, weighted: 7, title: 'delta four' }),
    ];
    const picked = allocateSlots(ranked, { cap: 5, isKid: false });
    expect(picked.has('a')).toBe(true);
    expect(picked.has('b')).toBe(true);
    expect(picked.has('c')).toBe(false); // i1 already at cap=2
    expect(picked.has('d')).toBe(true);
  });

  it('honours a tighter per-interest cap for kids (= 1)', () => {
    const ranked: AllocatableItem[] = [
      item({ candidateId: 'a', interestId: 'i1', rank: 1, weighted: 10, title: 'alpha one' }),
      item({ candidateId: 'b', interestId: 'i1', rank: 1, weighted: 9, title: 'beta two' }),
      item({ candidateId: 'c', interestId: 'i2', rank: 1, weighted: 8, title: 'gamma three' }),
    ];
    const picked = allocateSlots(ranked, { cap: 5, isKid: true });
    expect(picked.has('a')).toBe(true);
    expect(picked.has('b')).toBe(false); // i1 already at cap=1
    expect(picked.has('c')).toBe(true);
  });

  it('blocks near-duplicate titles via similarity dedup', () => {
    const ranked: AllocatableItem[] = [
      item({
        candidateId: 'a', interestId: 'i1', rank: 1, weighted: 10,
        title: 'Running form drills for distance runners',
      }),
      item({
        candidateId: 'b', interestId: 'i2', rank: 1, weighted: 9,
        title: 'Distance running form drills explained',
      }),
      item({
        candidateId: 'c', interestId: 'i3', rank: 1, weighted: 8,
        title: 'Cooking pasta from scratch',
      }),
    ];
    const picked = allocateSlots(ranked, { cap: 5, isKid: false });
    expect(picked.has('a')).toBe(true);
    expect(picked.has('b')).toBe(false); // jaccard with a is high
    expect(picked.has('c')).toBe(true);
  });

  it('skips rank ≤ 3 in stretch slots', () => {
    // cap=2 → stretchQuota=1, regularQuota=1.
    const ranked: AllocatableItem[] = [
      item({ candidateId: 'a', interestId: 'i1', rank: 2, weighted: 10, title: 'alpha solo' }),
      item({ candidateId: 'b', interestId: 'i2', rank: 3, weighted: 8, title: 'beta solo' }),
      item({ candidateId: 'c', interestId: 'i3', rank: 4, weighted: 6, title: 'charlie solo' }),
    ];
    const picked = allocateSlots(ranked, { cap: 2, isKid: false });
    expect(picked.get('a')).toBe('regular');
    expect(picked.has('b')).toBe(false); // rank=3, blocked from stretch
    expect(picked.get('c')).toBe('stretch');
  });

  it('respects prefilled titles + interest counts on a mid-day re-run', () => {
    const ranked: AllocatableItem[] = [
      item({
        candidateId: 'a', interestId: 'i1', rank: 1, weighted: 10,
        title: 'morning routine basics',
      }),
      item({
        candidateId: 'b', interestId: 'i2', rank: 2, weighted: 9,
        title: 'pasta from scratch tutorial',
      }),
    ];
    const prefilledInterestCounts = new Map<string, number>([['i1', 2]]); // already at cap
    const prefilledTitles = ['Pasta from scratch — full guide']; // similar to b
    const picked = allocateSlots(ranked, {
      cap: 5,
      isKid: false,
      prefilledTitles,
      prefilledInterestCounts,
    });
    expect(picked.has('a')).toBe(false); // i1 already at adult cap
    expect(picked.has('b')).toBe(false); // similar to a prefilled title
  });

  it('returns short rather than relaxing rules when diversity blocks fill', () => {
    const ranked: AllocatableItem[] = [
      item({ candidateId: 'a', interestId: 'i1', rank: 1, weighted: 10, title: 'one alpha' }),
      item({ candidateId: 'b', interestId: 'i1', rank: 1, weighted: 9, title: 'two bravo' }),
      item({ candidateId: 'c', interestId: 'i1', rank: 1, weighted: 8, title: 'three charlie' }),
      item({ candidateId: 'd', interestId: 'i1', rank: 1, weighted: 7, title: 'four delta' }),
    ];
    const picked = allocateSlots(ranked, { cap: 10, isKid: false });
    // adult cap=2, all items in i1 → only 2 picked even though cap=10
    expect(picked.size).toBe(2);
  });
});
