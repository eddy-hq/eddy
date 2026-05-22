import { describe, it, expect } from 'vitest';
import {
  rank,
  bucketFor,
  isPicked,
  freshnessMultiplier,
  rankWeight,
  titleTokens,
  jaccardSimilarity,
  normalizeSensitivity,
  clampScore,
  BACK_CATALOG_QUOTA,
  DELIGHTER_QUOTA,
  MAX_PER_INTEREST,
  MAX_PER_CHANNEL,
  type RankerCandidate,
  type RankerContext,
  type Verdict,
} from './ranker';

const NOW = new Date('2026-04-25T12:00:00.000Z');

// Default candidate is a delighter (interest_search) unless sourceType is
// overridden — most diversity-cap tests don't care about the bucket.
function candidate(overrides: Partial<RankerCandidate> & { candidateId: string }): RankerCandidate {
  return {
    candidateId: overrides.candidateId,
    title: overrides.title ?? `title-${overrides.candidateId}`,
    publishedAt: overrides.publishedAt ?? '2026-04-24T12:00:00.000Z',
    connectionScore: overrides.connectionScore ?? 8,
    qualityScore: overrides.qualityScore ?? 8,
    timeSensitivity: overrides.timeSensitivity ?? 'evergreen',
    sourceType: overrides.sourceType ?? 'interest_search',
    interestId: overrides.interestId ?? null,
    channel: overrides.channel ?? null,
    rank: overrides.rank ?? 5,
  };
}

function ctx(overrides: Partial<RankerContext> = {}): RankerContext {
  const base: RankerContext = {
    now: overrides.now ?? NOW,
    prefilledTitles: overrides.prefilledTitles ?? [],
    prefilledInterestCounts: overrides.prefilledInterestCounts ?? new Map(),
  };
  if (overrides.prefilledChannelCounts !== undefined) {
    base.prefilledChannelCounts = overrides.prefilledChannelCounts;
  }
  if (overrides.prefilledBucketCounts !== undefined) {
    base.prefilledBucketCounts = overrides.prefilledBucketCounts;
  }
  return base;
}

function findVerdict(verdicts: Verdict[], id: string): Verdict {
  const v = verdicts.find((x) => x.candidate.candidateId === id);
  if (!v) throw new Error(`no verdict for ${id}`);
  return v;
}

// Distinct, non-overlapping title tokens so similarity dedup never bites
// between siblings in count-based tests.
const TITLE_TOKEN_BANK = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'yankee', 'zulu', 'apple', 'banana', 'cherry', 'date',
];

function uniqueTitle(i: number): string {
  return TITLE_TOKEN_BANK[i] ?? `unique${i}`;
}

describe('bucketFor', () => {
  it('maps source_type to bucket; null/unknown → delighter', () => {
    expect(bucketFor('subscription')).toBe('subscription');
    expect(bucketFor('person_backcatalog')).toBe('back_catalog');
    expect(bucketFor('interest_search')).toBe('delighter');
    expect(bucketFor(null)).toBe('delighter');
    expect(bucketFor('something_else')).toBe('delighter');
  });
});

describe('isPicked', () => {
  it('only the three bucket dispositions count as picks', () => {
    expect(isPicked('subscription')).toBe(true);
    expect(isPicked('back_catalog')).toBe(true);
    expect(isPicked('delighter')).toBe(true);
    expect(isPicked('cut_quota')).toBe(false);
    expect(isPicked('cut_channel_cap')).toBe(false);
    expect(isPicked('low_conn')).toBe(false);
  });
});

describe('rank — three-bucket floors (ADR-0009)', () => {
  // Build a bucket of distinct-channel, distinct-interest, distinct-title
  // candidates so only the bucket quota bounds picks. Each is high-scoring.
  function bucket(prefix: string, sourceType: string, n: number): RankerCandidate[] {
    return Array.from({ length: n }, (_, i) => candidate({
      candidateId: `${prefix}${i}`,
      sourceType,
      interestId: `${prefix}-i${i}`,
      channel: `${prefix}-chan${i}`,
      title: `${prefix}${i} ` + uniqueTitle(i),
      rank: 5,
      connectionScore: 10,
      qualityScore: 10,
    }));
  }

  it('back-catalogue fills exactly its floor of 4 when supply is ample', () => {
    const verdicts = rank(bucket('bc', 'person_backcatalog', 10), ctx(), { cap: 15 });
    const picked = verdicts.filter((v) => v.disposition === 'back_catalog');
    expect(picked).toHaveLength(BACK_CATALOG_QUOTA);
    // The 5th+ back-catalogue items are cut for quota, not a cap.
    const cut = verdicts.filter((v) => v.disposition === 'cut_quota');
    expect(cut).toHaveLength(10 - BACK_CATALOG_QUOTA);
  });

  it('delighter fills exactly its floor of 2 when supply is ample', () => {
    const verdicts = rank(bucket('dl', 'interest_search', 10), ctx(), { cap: 15 });
    const picked = verdicts.filter((v) => v.disposition === 'delighter');
    expect(picked).toHaveLength(DELIGHTER_QUOTA);
    expect(verdicts.filter((v) => v.disposition === 'cut_quota')).toHaveLength(10 - DELIGHTER_QUOTA);
  });

  it('subscription fills cap − 6 when supply is ample', () => {
    const cap = 15;
    const verdicts = rank(bucket('sub', 'subscription', 20), ctx(), { cap });
    const picked = verdicts.filter((v) => v.disposition === 'subscription');
    expect(picked).toHaveLength(cap - 6); // 9
  });

  it('a full slate composes subscription cap−6 + back-cat 4 + delighter 2', () => {
    const cap = 15;
    const candidates = [
      ...bucket('sub', 'subscription', 20),
      ...bucket('bc', 'person_backcatalog', 10),
      ...bucket('dl', 'interest_search', 10),
    ];
    const verdicts = rank(candidates, ctx(), { cap });
    expect(verdicts.filter((v) => v.disposition === 'subscription')).toHaveLength(cap - 6);
    expect(verdicts.filter((v) => v.disposition === 'back_catalog')).toHaveLength(BACK_CATALOG_QUOTA);
    expect(verdicts.filter((v) => v.disposition === 'delighter')).toHaveLength(DELIGHTER_QUOTA);
    expect(verdicts.filter((v) => isPicked(v.disposition))).toHaveLength(cap);
  });
});

describe('rank — flood day: floors hold, spare is NOT soaked', () => {
  function bucket(prefix: string, sourceType: string, n: number): RankerCandidate[] {
    return Array.from({ length: n }, (_, i) => candidate({
      candidateId: `${prefix}${i}`,
      sourceType,
      interestId: `${prefix}-i${i}`,
      channel: `${prefix}-chan${i}`,
      title: `${prefix}${i} ` + uniqueTitle(i),
      rank: 5,
      connectionScore: 10,
      qualityScore: 10,
    }));
  }

  it('subscription supply > cap−6 does not eat into back-cat / delighter floors', () => {
    const cap = 15;
    // 30 subscriptions flood the day; back-cat and delighter each have exactly
    // their floor worth of supply.
    const candidates = [
      ...bucket('sub', 'subscription', 30),
      ...bucket('bc', 'person_backcatalog', BACK_CATALOG_QUOTA),
      ...bucket('dl', 'interest_search', DELIGHTER_QUOTA),
    ];
    const verdicts = rank(candidates, ctx(), { cap });
    // Subscriptions are capped at cap−6 even though 30 are available.
    expect(verdicts.filter((v) => v.disposition === 'subscription')).toHaveLength(cap - 6);
    // Floors still fully filled — not soaked away by the subscription flood.
    expect(verdicts.filter((v) => v.disposition === 'back_catalog')).toHaveLength(BACK_CATALOG_QUOTA);
    expect(verdicts.filter((v) => v.disposition === 'delighter')).toHaveLength(DELIGHTER_QUOTA);
    // The excess subscriptions are cut for quota.
    expect(verdicts.filter((v) => v.disposition === 'cut_quota')).toHaveLength(30 - (cap - 6));
  });

  it('a thin back-cat bucket yields a short slate; spare is NOT reallocated to subscription', () => {
    const cap = 15;
    // Plenty of subscriptions, but only 1 back-cat and 0 delighters.
    const candidates = [
      ...bucket('sub', 'subscription', 30),
      ...bucket('bc', 'person_backcatalog', 1),
    ];
    const verdicts = rank(candidates, ctx(), { cap });
    // Subscription still capped at cap−6 — the unused back-cat/delighter slots
    // are NOT handed to subscriptions.
    expect(verdicts.filter((v) => v.disposition === 'subscription')).toHaveLength(cap - 6);
    expect(verdicts.filter((v) => v.disposition === 'back_catalog')).toHaveLength(1);
    expect(verdicts.filter((v) => v.disposition === 'delighter')).toHaveLength(0);
    // Total slate is short: 9 + 1 + 0 = 10, not the full cap of 15.
    expect(verdicts.filter((v) => isPicked(v.disposition))).toHaveLength((cap - 6) + 1);
  });
});

describe('rank — cap arithmetic and short slates', () => {
  function bucket(prefix: string, sourceType: string, n: number): RankerCandidate[] {
    return Array.from({ length: n }, (_, i) => candidate({
      candidateId: `${prefix}${i}`,
      sourceType,
      interestId: `${prefix}-i${i}`,
      channel: `${prefix}-chan${i}`,
      title: `${prefix}${i} ` + uniqueTitle(i),
      rank: 5,
      connectionScore: 10,
      qualityScore: 10,
    }));
  }

  it.each([
    { cap: 15, sub: 9 },
    { cap: 10, sub: 4 },
    { cap: 8, sub: 2 },
    { cap: 6, sub: 0 },
    { cap: 5, sub: 0 }, // cap below reserved → subscription clamped to 0
  ])('cap=$cap → subscription quota $sub (cap−6 clamped at 0)', ({ cap, sub }) => {
    const verdicts = rank(bucket('sub', 'subscription', 30), ctx(), { cap });
    expect(verdicts.filter((v) => v.disposition === 'subscription')).toHaveLength(sub);
  });

  it('an empty pool yields an empty (valid) slate', () => {
    const verdicts = rank([], ctx(), { cap: 15 });
    expect(verdicts).toHaveLength(0);
  });
});

describe('rank — per-channel cap (global, all buckets incl. subscriptions)', () => {
  it('cap exactly reached: 2 from one channel pass, 3rd is cut (delighter)', () => {
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'a', interestId: 'i1', channel: 'Chan', rank: 5, title: 'alpha unique here', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'b', interestId: 'i2', channel: 'Chan', rank: 5, title: 'bravo separate words', connectionScore: 9, qualityScore: 9 }),
      candidate({ candidateId: 'c', interestId: 'i3', channel: 'Chan', rank: 5, title: 'charlie distinct phrase', connectionScore: 8, qualityScore: 8 }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('delighter');
    expect(findVerdict(verdicts, 'b').disposition).toBe('delighter');
    expect(findVerdict(verdicts, 'c').disposition).toBe('cut_channel_cap');
  });

  it('per-channel cap applies to subscriptions: 3rd from one channel is cut', () => {
    // Subscriptions skip the interest cap but NOT the channel cap (ADR-0009).
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'a', sourceType: 'subscription', interestId: 'i1', channel: 'SubChan', rank: 5, title: 'alpha unique here', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'b', sourceType: 'subscription', interestId: 'i2', channel: 'SubChan', rank: 5, title: 'bravo separate words', connectionScore: 9, qualityScore: 9 }),
      candidate({ candidateId: 'c', sourceType: 'subscription', interestId: 'i3', channel: 'SubChan', rank: 5, title: 'charlie distinct phrase', connectionScore: 8, qualityScore: 8 }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('subscription');
    expect(findVerdict(verdicts, 'b').disposition).toBe('subscription');
    expect(findVerdict(verdicts, 'c').disposition).toBe('cut_channel_cap');
  });

  it('per-channel cap wins when both channel and interest caps would apply', () => {
    // Three delighters on the same interest AND same channel. Channel cap (2)
    // trips at item 3; interest cap (3) hasn't yet. Channel check is first.
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'a', interestId: 'i1', channel: 'One', rank: 5, title: 'alpha unique here', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'b', interestId: 'i1', channel: 'One', rank: 5, title: 'bravo separate words', connectionScore: 9, qualityScore: 10 }),
      candidate({ candidateId: 'c', interestId: 'i1', channel: 'One', rank: 5, title: 'charlie distinct phrase', connectionScore: 9, qualityScore: 9 }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'c').disposition).toBe('cut_channel_cap');
  });

  it('cap unified at 2 for everyone (no kid split)', () => {
    expect(MAX_PER_CHANNEL).toBe(2);
    expect(MAX_PER_INTEREST).toBe(3);
  });

  it('prefilledChannelCounts: cap is consumed by earlier-today picks', () => {
    const prefilled = new Map<string, number>([['PrefilledChan', 2]]);
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'new', interestId: 'i1', channel: 'PrefilledChan', rank: 5, title: 'alpha unique here', connectionScore: 10, qualityScore: 10 }),
    ];
    const verdicts = rank(candidates, ctx({ prefilledChannelCounts: prefilled }), { cap: 15 });
    expect(findVerdict(verdicts, 'new').disposition).toBe('cut_channel_cap');
  });

  it('null channel is exempt from the cap (subscriptions, ample quota)', () => {
    // Subscriptions so the bucket quota (cap−6=9) doesn't bound these three.
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'a', sourceType: 'subscription', interestId: 'i1', channel: null, rank: 5, title: 'alpha unique here', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'b', sourceType: 'subscription', interestId: 'i2', channel: null, rank: 5, title: 'bravo separate words', connectionScore: 9, qualityScore: 9 }),
      candidate({ candidateId: 'c', sourceType: 'subscription', interestId: 'i3', channel: null, rank: 5, title: 'charlie distinct phrase', connectionScore: 8, qualityScore: 8 }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('subscription');
    expect(findVerdict(verdicts, 'b').disposition).toBe('subscription');
    expect(findVerdict(verdicts, 'c').disposition).toBe('subscription');
  });
});

describe('rank — per-interest cap (back-cat + delighter only, NOT subscriptions)', () => {
  it('per-interest cap bites on back-catalogue when channels differ', () => {
    // Four back-catalogue items share interest i1 on different channels
    // (channel cap never trips). Back-cat quota is 4, so the quota doesn't
    // cut first — the 4th hits the per-interest cap of 3.
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'a', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'ChA', rank: 5, title: 'alpha unique here', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'b', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'ChB', rank: 5, title: 'bravo separate words', connectionScore: 9, qualityScore: 10 }),
      candidate({ candidateId: 'c', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'ChC', rank: 5, title: 'charlie distinct phrase', connectionScore: 9, qualityScore: 9 }),
      candidate({ candidateId: 'd', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'ChD', rank: 5, title: 'delta further lexis', connectionScore: 8, qualityScore: 9 }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'a').disposition).toBe('back_catalog');
    expect(findVerdict(verdicts, 'b').disposition).toBe('back_catalog');
    expect(findVerdict(verdicts, 'c').disposition).toBe('back_catalog');
    expect(findVerdict(verdicts, 'd').disposition).toBe('cut_interest_cap');
  });

  it('per-interest cap does NOT bite on subscriptions sharing one interest', () => {
    // Five subscriptions all on interest i1 but distinct channels: the
    // per-interest cap must NOT suppress them (ADR-0009). Only the
    // subscription bucket quota (cap−6) bounds them.
    const candidates: RankerCandidate[] = Array.from({ length: 5 }, (_, i) => candidate({
      candidateId: `s${i}`,
      sourceType: 'subscription',
      interestId: 'i1', // all the same inferred interest
      channel: `SubCh${i}`, // distinct channels
      rank: 5,
      title: uniqueTitle(i) + ' sub',
      connectionScore: 10,
      qualityScore: 10,
    }));
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    // All 5 surface as subscriptions (cap−6 = 9 ≥ 5), none cut for interest cap.
    expect(verdicts.filter((v) => v.disposition === 'subscription')).toHaveLength(5);
    expect(verdicts.filter((v) => v.disposition === 'cut_interest_cap')).toHaveLength(0);
  });

  it('subscriptions do NOT consume the per-interest budget of back-cat siblings', () => {
    // Two subscriptions on interest i1 (exempt) plus three back-cat on i1.
    // The back-cat bucket should get its full per-interest allowance of 3 —
    // the subscriptions must not have eaten into it.
    const candidates: RankerCandidate[] = [
      candidate({ candidateId: 'sub1', sourceType: 'subscription', interestId: 'i1', channel: 'SA', rank: 5, title: 'alpha sub', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'sub2', sourceType: 'subscription', interestId: 'i1', channel: 'SB', rank: 5, title: 'bravo sub', connectionScore: 10, qualityScore: 10 }),
      candidate({ candidateId: 'bc1', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'BA', rank: 5, title: 'charlie bc', connectionScore: 9, qualityScore: 9 }),
      candidate({ candidateId: 'bc2', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'BB', rank: 5, title: 'delta bc', connectionScore: 9, qualityScore: 9 }),
      candidate({ candidateId: 'bc3', sourceType: 'person_backcatalog', interestId: 'i1', channel: 'BC', rank: 5, title: 'echo bc', connectionScore: 9, qualityScore: 9 }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'bc1').disposition).toBe('back_catalog');
    expect(findVerdict(verdicts, 'bc2').disposition).toBe('back_catalog');
    expect(findVerdict(verdicts, 'bc3').disposition).toBe('back_catalog');
  });
});

describe('rank — rankWeight forced 1.0 for subscription + back-catalogue', () => {
  // A low-ranked interest (rank 9 → rankWeight ≈ 0.33) on a delighter is
  // heavily down-weighted; the same scores as a subscription/back-cat are NOT.
  // publishedAt is 1 day before NOW → evergreen freshness (days ≤ 1) = 1.4.
  const FRESH_1D_EVERGREEN = 1.4;

  it('subscription weighted score ignores interest rank', () => {
    const c = candidate({
      candidateId: 'sub', sourceType: 'subscription', interestId: 'i1', rank: 9,
      connectionScore: 8, qualityScore: 8, timeSensitivity: 'evergreen',
      publishedAt: '2026-04-24T12:00:00.000Z',
    });
    const v = findVerdict(rank([c], ctx(), { cap: 15 }), 'sub');
    // weighted = 8 × 8 × 1.4 × 1.0 (forced) — rankWeight(9) NOT applied.
    expect(v.weighted).toBeCloseTo(8 * 8 * FRESH_1D_EVERGREEN * 1.0, 5);
  });

  it('back-catalogue weighted score ignores interest rank', () => {
    const c = candidate({
      candidateId: 'bc', sourceType: 'person_backcatalog', interestId: 'i1', rank: 9,
      connectionScore: 8, qualityScore: 8, timeSensitivity: 'evergreen',
      publishedAt: '2026-04-24T12:00:00.000Z',
    });
    const v = findVerdict(rank([c], ctx(), { cap: 15 }), 'bc');
    expect(v.weighted).toBeCloseTo(8 * 8 * FRESH_1D_EVERGREEN * 1.0, 5);
  });

  it('delighter keeps rankWeight(interest_rank)', () => {
    const c = candidate({
      candidateId: 'dl', sourceType: 'interest_search', interestId: 'i1', rank: 9,
      connectionScore: 8, qualityScore: 8, timeSensitivity: 'evergreen',
      publishedAt: '2026-04-24T12:00:00.000Z',
    });
    const v = findVerdict(rank([c], ctx(), { cap: 15 }), 'dl');
    // weighted = 8 × 8 × 1.4 × rankWeight(9).
    expect(v.weighted).toBeCloseTo(8 * 8 * FRESH_1D_EVERGREEN * rankWeight(9), 5);
  });

  it('a low-rank subscription outranks a low-rank delighter with identical axes', () => {
    const sub = candidate({ candidateId: 'sub', sourceType: 'subscription', interestId: 'i1', channel: 'CA', rank: 9, connectionScore: 8, qualityScore: 8, title: 'alpha sub' });
    const dl = candidate({ candidateId: 'dl', sourceType: 'interest_search', interestId: 'i2', channel: 'CB', rank: 9, connectionScore: 8, qualityScore: 8, title: 'bravo dl' });
    const verdicts = rank([dl, sub], ctx(), { cap: 15 });
    // Ordering is weighted-desc — the subscription (weight 1.0) sorts above the
    // delighter (weight ≈ 0.33).
    expect(verdicts[0]?.candidate.candidateId).toBe('sub');
    expect(verdicts[1]?.candidate.candidateId).toBe('dl');
  });
});

describe('rank — title dedup is global across buckets', () => {
  it("a back-cat title-similar to a higher-weighted subscription is cut_dedup", () => {
    const sub = candidate({
      candidateId: 'sub', sourceType: 'subscription', interestId: 'i1', channel: 'CA', rank: 5,
      title: 'pasta from scratch tutorial', connectionScore: 10, qualityScore: 10,
    });
    const bc = candidate({
      candidateId: 'bc', sourceType: 'person_backcatalog', interestId: 'i2', channel: 'CB', rank: 5,
      title: 'tutorial pasta scratch made', connectionScore: 8, qualityScore: 8,
    });
    const verdicts = rank([sub, bc], ctx(), { cap: 15 });
    expect(findVerdict(verdicts, 'sub').disposition).toBe('subscription');
    const loser = findVerdict(verdicts, 'bc');
    expect(loser.disposition).toBe('cut_dedup');
    expect(loser.dedupedAgainst).toBe('sub');
  });
});

describe('rank — mid-day bucket prefill', () => {
  it('a prefilled subscription count tops up only to the remaining quota', () => {
    // cap 15 → subscription quota 9. With 9 already surfaced, no more fit.
    const prefilledBucketCounts = new Map([['subscription' as const, 9]]);
    const candidates = Array.from({ length: 5 }, (_, i) => candidate({
      candidateId: `s${i}`, sourceType: 'subscription', interestId: `i${i}`,
      channel: `Ch${i}`, rank: 5, title: uniqueTitle(i) + ' sub', connectionScore: 10, qualityScore: 10,
    }));
    const verdicts = rank(candidates, ctx({ prefilledBucketCounts }), { cap: 15 });
    expect(verdicts.filter((v) => v.disposition === 'subscription')).toHaveLength(0);
    expect(verdicts.filter((v) => v.disposition === 'cut_quota')).toHaveLength(5);
  });

  it('a partial prefill leaves room for the remainder of the quota', () => {
    // cap 15 → back-cat quota 4. With 3 prefilled, exactly 1 more fits.
    const prefilledBucketCounts = new Map([['back_catalog' as const, 3]]);
    const candidates = Array.from({ length: 5 }, (_, i) => candidate({
      candidateId: `b${i}`, sourceType: 'person_backcatalog', interestId: `i${i}`,
      channel: `Ch${i}`, rank: 5, title: uniqueTitle(i) + ' bc', connectionScore: 10, qualityScore: 10,
    }));
    const verdicts = rank(candidates, ctx({ prefilledBucketCounts }), { cap: 15 });
    expect(verdicts.filter((v) => v.disposition === 'back_catalog')).toHaveLength(1);
  });
});

describe('rank — score floors', () => {
  it('marks an old news item with passing axes as low_weight', () => {
    const twoYearsAgo = '2024-04-25T12:00:00.000Z';
    const candidates: RankerCandidate[] = [
      candidate({
        candidateId: 'old-news', sourceType: 'interest_search',
        publishedAt: twoYearsAgo, timeSensitivity: 'news',
        connectionScore: 9, qualityScore: 6, rank: 1, interestId: 'i1',
      }),
    ];
    const verdicts = rank(candidates, ctx(), { cap: 15 });
    const v = findVerdict(verdicts, 'old-news');
    expect(v.disposition).toBe('low_weight');
    expect(v.weighted).toBeCloseTo(9 * 6 * 0.05 * 1, 5);
  });

  it('low connection → low_conn before any bucket allocation', () => {
    const c = candidate({ candidateId: 'lc', sourceType: 'subscription', connectionScore: 3, qualityScore: 9 });
    expect(findVerdict(rank([c], ctx(), { cap: 15 }), 'lc').disposition).toBe('low_conn');
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
