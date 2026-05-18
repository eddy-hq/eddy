import { describe, it, expect } from 'vitest';
import {
  rank,
  freshnessMultiplier,
  rankWeight,
  titleTokens,
  jaccardSimilarity,
  normalizeSensitivity,
  clampScore,
  type RankerCandidate,
  type RankerContext,
  type Verdict,
} from './ranker';

const NOW = new Date('2026-04-25T12:00:00.000Z');

function candidate(overrides: Partial<RankerCandidate> & { candidateId: string }): RankerCandidate {
  return {
    candidateId: overrides.candidateId,
    title: overrides.title ?? `title-${overrides.candidateId}`,
    publishedAt: overrides.publishedAt ?? '2026-04-24T12:00:00.000Z',
    connectionScore: overrides.connectionScore ?? 8,
    qualityScore: overrides.qualityScore ?? 8,
    timeSensitivity: overrides.timeSensitivity ?? 'evergreen',
    interestId: overrides.interestId ?? null,
    channel: overrides.channel ?? null,
    rank: overrides.rank ?? 5,
  };
}

function ctx(overrides: Partial<RankerContext> = {}): RankerContext {
  const base: RankerContext = {
    now: overrides.now ?? NOW,
    isKid: overrides.isKid ?? false,
    prefilledTitles: overrides.prefilledTitles ?? [],
    prefilledInterestCounts: overrides.prefilledInterestCounts ?? new Map(),
  };
  if (overrides.prefilledChannelCounts !== undefined) {
    base.prefilledChannelCounts = overrides.prefilledChannelCounts;
  }
  return base;
}

function findVerdict(verdicts: Verdict[], id: string): Verdict {
  const v = verdicts.find((x) => x.candidate.candidateId === id);
  if (!v) throw new Error(`no verdict for ${id}`);
  return v;
}

describe('rank — per-channel cap (issue #148)', () => {
  // Adult cap = 2, kid cap = 1. Each test below uses distinct interests
  // on every candidate so the per-interest cap can't bite — the only
  // diversity rule under test is the channel cap. Unique title tokens
  // so dedup doesn't bite either.

  it('cap not reached: 2 candidates from one channel both survive (adult)', () => {
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', channel: 'AI Engineer', rank: 5,
        title: 'alpha unique tokens here',
        connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i2', channel: 'AI Engineer', rank: 5,
        title: 'bravo separate vocabulary',
        connectionScore: 9, qualityScore: 9,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('regular');
  });

  it('cap exactly reached: 2 from one channel pass, 3rd is cut (adult)', () => {
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', channel: 'AI Engineer', rank: 5,
        title: 'alpha unique tokens here',
        connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i2', channel: 'AI Engineer', rank: 5,
        title: 'bravo separate vocabulary',
        connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'c', interestId: 'i3', channel: 'AI Engineer', rank: 5,
        title: 'charlie another distinct phrase',
        connectionScore: 8, qualityScore: 8,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'c').disposition).toBe('cut_channel_cap');
  });

  it('cap exceeded: lower-scoring duplicates drop, higher-scoring keep their slots', () => {
    // Five candidates on the same channel, distinct interests, distinct
    // titles, sorted by descending weighted score (controlled via conn/qual).
    // Adult channel cap = 2 → top two survive, the bottom three are cut.
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'top1', interestId: 'i1', channel: 'Gary Economics', rank: 5,
        title: 'alpha unique tokens here', connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'top2', interestId: 'i2', channel: 'Gary Economics', rank: 5,
        title: 'bravo separate vocabulary', connectionScore: 9, qualityScore: 10,
      }),
      candidate({
        candidateId: 'mid1', interestId: 'i3', channel: 'Gary Economics', rank: 5,
        title: 'charlie another distinct phrase', connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'mid2', interestId: 'i4', channel: 'Gary Economics', rank: 5,
        title: 'delta further unique lexis', connectionScore: 8, qualityScore: 9,
      }),
      candidate({
        candidateId: 'low', interestId: 'i5', channel: 'Gary Economics', rank: 5,
        title: 'echo additional distinct wording', connectionScore: 8, qualityScore: 8,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'top1').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'top2').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'mid1').disposition).toBe('cut_channel_cap');
    expect(findVerdict(verdicts, 'mid2').disposition).toBe('cut_channel_cap');
    expect(findVerdict(verdicts, 'low').disposition).toBe('cut_channel_cap');
  });

  it('per-channel cap wins when both channel and interest caps would apply', () => {
    // Setup: three candidates on the same interest AND same channel.
    // Adult interest cap = 3 — wouldn't trip yet on the third item.
    // Adult channel cap = 2 — DOES trip on the third item.
    // The third item must therefore report cut_channel_cap, not
    // cut_interest_cap, because the channel cap is checked first.
    //
    // Then a fourth candidate shares the SAME interest AND SAME channel:
    // both caps now apply — channel cap (2) was hit at item 3, interest
    // cap (3) is hit at item 4. The fourth item still reports
    // cut_channel_cap because the channel check happens first.
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', channel: 'OneCreator', rank: 5,
        title: 'alpha unique tokens here', connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i1', channel: 'OneCreator', rank: 5,
        title: 'bravo separate vocabulary', connectionScore: 9, qualityScore: 10,
      }),
      candidate({
        candidateId: 'c', interestId: 'i1', channel: 'OneCreator', rank: 5,
        title: 'charlie another distinct phrase', connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'd', interestId: 'i1', channel: 'OneCreator', rank: 5,
        title: 'delta further unique lexis', connectionScore: 8, qualityScore: 9,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'c').disposition).toBe('cut_channel_cap');
    expect(findVerdict(verdicts, 'd').disposition).toBe('cut_channel_cap');
  });

  it('per-channel cap drops dupes without reordering to fill from other channels', () => {
    // Channel A has 3 items above any item from channel B. With adult
    // channel cap = 2, items 1+2 from A take the first two slots and
    // item 3 from A is dropped — channel B's items still fill the rest
    // in their own weighted order, not promoted in place of A's drop.
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a1', interestId: 'i1', channel: 'A', rank: 5,
        title: 'alpha first unique phrase', connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'a2', interestId: 'i2', channel: 'A', rank: 5,
        title: 'bravo second unique phrase', connectionScore: 10, qualityScore: 9,
      }),
      candidate({
        candidateId: 'a3', interestId: 'i3', channel: 'A', rank: 5,
        title: 'charlie third unique phrase', connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'b1', interestId: 'i4', channel: 'B', rank: 5,
        title: 'delta fourth unique phrase', connectionScore: 8, qualityScore: 8,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a1').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'a2').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'a3').disposition).toBe('cut_channel_cap');
    expect(findVerdict(verdicts, 'b1').disposition).toBe('regular');
  });

  it('kid channel cap = 1: second candidate from same channel is cut', () => {
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', channel: 'KidChannel', rank: 5,
        title: 'alpha unique tokens here', connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i2', channel: 'KidChannel', rank: 5,
        title: 'bravo separate vocabulary', connectionScore: 9, qualityScore: 9,
      }),
    ];
    const verdicts = rank(candidates, ctx({ isKid: true }), { cap: 5 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('cut_channel_cap');
  });

  it('null channel is exempt from the cap', () => {
    // Three candidates with channel=null and distinct interests: all
    // should pass — null channel means "channel unknown", which we
    // treat the same as null interest (no cap applies).
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', channel: null, rank: 5,
        title: 'alpha unique tokens here', connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i2', channel: null, rank: 5,
        title: 'bravo separate vocabulary', connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'c', interestId: 'i3', channel: null, rank: 5,
        title: 'charlie another distinct phrase', connectionScore: 8, qualityScore: 8,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'c').disposition).toBe('regular');
  });

  it('prefilledChannelCounts: cap is consumed by earlier-today picks', () => {
    // Channel "PrefilledChan" already counted twice (adult cap=2 fully
    // consumed by an earlier call's picks). The new candidate on the
    // same channel must be cut even though no other candidate from that
    // channel is in this call's pool.
    const prefilled = new Map<string, number>([['PrefilledChan', 2]]);
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'new', interestId: 'i1', channel: 'PrefilledChan', rank: 5,
        title: 'alpha unique tokens here', connectionScore: 10, qualityScore: 10,
      }),
    ];
    const verdicts = rank(
      candidates,
      ctx({ prefilledChannelCounts: prefilled }),
      { cap: 15 },
    );
    expect(findVerdict(verdicts, 'new').disposition).toBe('cut_channel_cap');
  });

  it('per-interest cap still bites independently when channels differ', () => {
    // Three candidates share interest i1 but each is on a different
    // channel (so channel cap never trips). The fourth on i1 must hit
    // the adult per-interest cap (3) and report cut_interest_cap.
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', channel: 'ChA', rank: 5,
        title: 'alpha unique tokens here', connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i1', channel: 'ChB', rank: 5,
        title: 'bravo separate vocabulary', connectionScore: 9, qualityScore: 10,
      }),
      candidate({
        candidateId: 'c', interestId: 'i1', channel: 'ChC', rank: 5,
        title: 'charlie another distinct phrase', connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'd', interestId: 'i1', channel: 'ChD', rank: 5,
        title: 'delta further unique lexis', connectionScore: 8, qualityScore: 9,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'c').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'd').disposition).toBe('cut_interest_cap');
  });
});

describe('rank — first-refusal precedence', () => {
  // Brief: refusals from regular pass stick. A candidate that hits BOTH
  // interest_cap (regular) and stretch_rank (stretch) gets the regular-
  // pass reason.
  it('cut_interest_cap wins over cut_stretch_rank when both apply', () => {
    const candidates: RankerCandidate[] = [
      // Three i1 items consume the adult cap of 3 first.
      candidate({ candidateId: 'a', interestId: 'i1', rank: 1, title: 'alpha solo run' }),
      candidate({ candidateId: 'b', interestId: 'i1', rank: 1, title: 'bravo cycle pace' }),
      candidate({ candidateId: 'c', interestId: 'i1', rank: 1, title: 'charlie hill repeats' }),
      // Item X: same i1 interest (cap full) AND rank 1 (would fail stretch).
      // Lower scores so it sorts last and is reached after the cap fills.
      candidate({
        candidateId: 'x', interestId: 'i1', rank: 1,
        title: 'xerox solo desk',
        connectionScore: 7, qualityScore: 6,
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 5 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'b').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'c').disposition).toBe('regular');
    expect(findVerdict(verdicts, 'x').disposition).toBe('cut_interest_cap');
  });
});

describe('rank — cut_dedup carries dedupedAgainst', () => {
  it("loser's verdict points at the higher-weighted winner", () => {
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'winner', interestId: 'i1', rank: 5,
        title: 'pasta from scratch tutorial',
        connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'loser', interestId: 'i2', rank: 5,
        title: 'tutorial pasta scratch made',
        connectionScore: 8, qualityScore: 8,
      }),
      candidate({
        candidateId: 'unrelated', interestId: 'i3', rank: 5,
        title: 'cycling cadence drills',
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 5 });
    expect(findVerdict(verdicts, 'winner').disposition).toBe('regular');
    const loser = findVerdict(verdicts, 'loser');
    expect(loser.disposition).toBe('cut_dedup');
    expect(loser.dedupedAgainst).toBe('winner');
    expect(findVerdict(verdicts, 'unrelated').disposition).toBe('regular');
  });
});

describe('rank — mid-day prefill round-trip', () => {
  it('second call honours interest caps and title dedup seeded from first picks', () => {
    const pool: RankerCandidate[] = [
      candidate({
        candidateId: 'a', interestId: 'i1', rank: 1,
        title: 'morning routine essentials',
        connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'b', interestId: 'i2', rank: 2,
        title: 'pasta from scratch tutorial',
        connectionScore: 9, qualityScore: 9,
      }),
    ];

    const first = rank(pool, ctx(), { cap: 5 });
    const firstPicks = first.filter((v) => v.disposition === 'regular' || v.disposition === 'stretch');
    expect(firstPicks.map((v) => v.candidate.candidateId).sort()).toEqual(['a', 'b']);

    const prefilledTitles = firstPicks.map((v) => v.candidate.title ?? '').filter((t) => t.length > 0);
    const prefilledInterestCounts = new Map<string, number>();
    for (const v of firstPicks) {
      if (!v.candidate.interestId) continue;
      prefilledInterestCounts.set(
        v.candidate.interestId,
        (prefilledInterestCounts.get(v.candidate.interestId) ?? 0) + 1,
      );
    }

    // Second-call pool: one item shares i1 (1 prefilled, adult max=3, so
    // room for two more), one item shares i2 (also room), one item is
    // title-similar to the first call's pasta pick, one item is fresh and
    // distinct.
    const secondPool: RankerCandidate[] = [
      candidate({
        candidateId: 'c', interestId: 'i1', rank: 1,
        title: 'morning sunrise breath drill', // similar to "morning routine essentials"
        connectionScore: 10, qualityScore: 10,
      }),
      candidate({
        candidateId: 'd', interestId: 'i2', rank: 2,
        title: 'tutorial pasta scratch made fresh', // similar to "pasta from scratch tutorial"
        connectionScore: 9, qualityScore: 9,
      }),
      candidate({
        candidateId: 'e', interestId: 'i3', rank: 1,
        title: 'cycling cadence drills',
        connectionScore: 9, qualityScore: 9,
      }),
    ];

    const second = rank(
      secondPool,
      ctx({ prefilledTitles, prefilledInterestCounts }),
      { cap: 5 },
    );

    // 'c' has same interest as a prefilled pick — but adult cap=3, so the
    // interest cap doesn't bite yet. Title-dedup against "morning routine
    // essentials" might bite though. Let's check: c shares 'morning' which
    // is one of the few non-stopwords in 'morning routine essentials'.
    // Tokens of a: 'morning', 'routine', 'essentials' (3 tokens)
    // Tokens of c: 'morning', 'sunrise', 'breath', 'drill' (4 tokens)
    // Intersection: 'morning' (1). Union: 6. Jaccard: 1/6 = 0.166. < 0.4.
    // So c is NOT deduped — expected pickable.
    expect(findVerdict(second, 'c').disposition).toBe('regular');

    // 'd' is title-similar to "pasta from scratch tutorial":
    // Tokens of b: 'pasta', 'scratch', 'tutorial'
    // Tokens of d: 'tutorial', 'pasta', 'scratch', 'made', 'fresh'
    // Intersection: 3, union: 5, Jaccard: 0.6 > 0.4 → cut_dedup.
    expect(findVerdict(second, 'd').disposition).toBe('cut_dedup');

    // 'e' has neither cap nor dedup conflict.
    expect(findVerdict(second, 'e').disposition).toBe('regular');
  });
});

describe('rank — weighted floor catches old news', () => {
  // Brief §9a: a 2-year-old "news" item still scoring conn 9 / qual 6 has
  // weighted ≈ 9 × 6 × 0.05 (news >90d) × 1 = 2.7, well under MIN_WEIGHTED
  // _SCORE = 5. The floor is what stops the per-interest cap forcing in
  // weak picks just because nothing better exists for that interest.
  it('marks an old news item with passing axes as low_weight', () => {
    const twoYearsAgo = '2024-04-25T12:00:00.000Z';
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'old-news',
        publishedAt: twoYearsAgo,
        timeSensitivity: 'news',
        connectionScore: 9,
        qualityScore: 6,
        rank: 1,
        interestId: 'i1',
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 5 });
    const v = findVerdict(verdicts, 'old-news');
    expect(v.disposition).toBe('low_weight');
    expect(v.weighted).toBeCloseTo(9 * 6 * 0.05 * 1, 5);
  });
});

describe('rank — stretch-quota math at boundaries', () => {
  // Each candidate has a unique interest and rank > 3 so neither the cap
  // nor the stretch-rank gate blocks anyone — only the quota math limits
  // total picks. cap=15 → 12 regular + 3 stretch; cap=5 → 4+1; cap=2 → 1+1.
  // Distinct, non-overlapping title tokens so similarity dedup never bites
  // between siblings — only the slot quota math should limit picks.
  const TITLE_TOKEN_BANK = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
    'quebec', 'romeo', 'sierra', 'tango',
  ];
  function pool(n: number): RankerCandidate[] {
    return Array.from({ length: n }, (_, i) => candidate({
      candidateId: `c${i}`,
      interestId: `i${i}`,
      rank: 10,
      title: TITLE_TOKEN_BANK[i] ?? `unique${i}`,
      connectionScore: 10,
      qualityScore: 10,
    }));
  }

  it.each([
    { cap: 15, regular: 12, stretch: 3 },
    { cap: 5, regular: 4, stretch: 1 },
    { cap: 2, regular: 1, stretch: 1 },
  ])('cap=$cap → $regular regular + $stretch stretch', ({ cap, regular, stretch }) => {
    const verdicts = rank(pool(20), ctx(), { cap });
    const regulars = verdicts.filter((v) => v.disposition === 'regular').length;
    const stretches = verdicts.filter((v) => v.disposition === 'stretch').length;
    expect(regulars).toBe(regular);
    expect(stretches).toBe(stretch);
  });
});

describe('freshnessMultiplier', () => {
  it('news decays fast over the first month', () => {
    expect(freshnessMultiplier('2026-04-25T00:00:00.000Z', 'news', NOW)).toBe(1.6);
    expect(freshnessMultiplier('2026-04-20T12:00:00.000Z', 'news', NOW)).toBe(0.6);
    expect(freshnessMultiplier('2026-03-26T12:00:00.000Z', 'news', NOW)).toBe(0.2);
    expect(freshnessMultiplier('2025-12-25T12:00:00.000Z', 'news', NOW)).toBeLessThanOrEqual(0.1);
  });

  it('evergreen stays nearly flat across the year', () => {
    expect(freshnessMultiplier('2026-04-25T00:00:00.000Z', 'evergreen', NOW)).toBe(1.4);
    expect(freshnessMultiplier('2026-03-26T12:00:00.000Z', 'evergreen', NOW)).toBe(1.1);
    expect(freshnessMultiplier('2025-05-01T12:00:00.000Z', 'evergreen', NOW)).toBe(1.0);
    expect(freshnessMultiplier('2024-01-01T12:00:00.000Z', 'evergreen', NOW)).toBe(0.9);
  });

  it('standard sits between news and evergreen', () => {
    expect(freshnessMultiplier('2026-04-25T00:00:00.000Z', 'standard', NOW)).toBe(1.6);
    expect(freshnessMultiplier('2026-04-19T12:00:00.000Z', 'standard', NOW)).toBe(1.2);
    expect(freshnessMultiplier('2025-12-25T12:00:00.000Z', 'standard', NOW)).toBe(0.4);
  });

  it('falls back per kind when published_at is null', () => {
    expect(freshnessMultiplier(null, 'news', NOW)).toBe(0.5);
    expect(freshnessMultiplier(null, 'evergreen', NOW)).toBe(1.0);
    expect(freshnessMultiplier(null, 'standard', NOW)).toBe(0.8);
    expect(freshnessMultiplier(null, null, NOW)).toBe(0.8);
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
    const tokens = titleTokens('How to Build a Real-Time Chat App!');
    expect(tokens).toEqual(new Set(['build', 'real', 'time', 'chat', 'app']));
    expect(tokens.has('how')).toBe(false);
    expect(tokens.has('to')).toBe(false);
    expect(tokens.has('a')).toBe(false);
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
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });
});

describe('normalizeSensitivity', () => {
  it('passes "news" through', () => {
    expect(normalizeSensitivity('news')).toBe('news');
  });

  it('passes "evergreen" through, including mixed-case + whitespace', () => {
    expect(normalizeSensitivity('Evergreen')).toBe('evergreen');
    expect(normalizeSensitivity('  EVERGREEN  ')).toBe('evergreen');
  });

  it('passes "standard" through', () => {
    expect(normalizeSensitivity('standard')).toBe('standard');
  });

  it('falls back to "standard" on unknown values', () => {
    expect(normalizeSensitivity('whatever')).toBe('standard');
    expect(normalizeSensitivity(null)).toBe('standard');
    expect(normalizeSensitivity(undefined)).toBe('standard');
  });
});

describe('clampScore', () => {
  it('passes in-range numbers through', () => {
    expect(clampScore(0)).toBe(0);
    expect(clampScore(5.5)).toBe(5.5);
    expect(clampScore(10)).toBe(10);
  });

  it('clamps below 0 to 0', () => {
    expect(clampScore(-3)).toBe(0);
  });

  it('clamps above 10 to 10', () => {
    expect(clampScore(15)).toBe(10);
  });

  it('returns null for non-finite or non-number input', () => {
    expect(clampScore(NaN)).toBeNull();
    expect(clampScore(Infinity)).toBeNull();
    expect(clampScore('7')).toBeNull();
    expect(clampScore(undefined)).toBeNull();
  });
});
