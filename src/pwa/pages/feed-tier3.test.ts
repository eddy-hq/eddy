import { describe, expect, it } from 'vitest';
import {
  ageInDays,
  agoLabel,
  isQuiet,
  isTier2Age,
  isTier3Age,
  itemsLabel,
  moreCount,
  provenanceSegments,
} from './feed-tier3';

const TODAY = '2026-05-25';

describe('ageInDays', () => {
  it('is a pure calendar-day delta (UTC midnight), ignoring time of day', () => {
    expect(ageInDays('2026-05-25', TODAY)).toBe(0);
    expect(ageInDays('2026-05-24', TODAY)).toBe(1);
    expect(ageInDays('2026-05-18', TODAY)).toBe(7);
    expect(ageInDays('2026-04-26', TODAY)).toBe(29);
    expect(ageInDays('2026-04-25', TODAY)).toBe(30);
  });

  it('goes negative for a future-dated day', () => {
    expect(ageInDays('2026-05-26', TODAY)).toBe(-1);
  });
});

describe('tier split boundaries', () => {
  it('age 6 is Tier 2, not Tier 3', () => {
    expect(isTier2Age(6)).toBe(true);
    expect(isTier3Age(6)).toBe(false);
  });

  it('age 7 is Tier 3, not Tier 2', () => {
    expect(isTier2Age(7)).toBe(false);
    expect(isTier3Age(7)).toBe(true);
  });

  it('age 29 is Tier 3', () => {
    expect(isTier3Age(29)).toBe(true);
  });

  it('age 30 is neither Tier 2 nor Tier 3 (it is Tier 4)', () => {
    expect(isTier2Age(30)).toBe(false);
    expect(isTier3Age(30)).toBe(false);
  });

  it('today (age 0) is Tier 2 range but excluded by the caller as Tier 1', () => {
    expect(isTier2Age(0)).toBe(true);
  });
});

describe('isQuiet (quiet-variant threshold)', () => {
  it('does not dim a 13-day-old row', () => {
    expect(isQuiet(13)).toBe(false);
  });

  it('dims a row at exactly 14 days', () => {
    expect(isQuiet(14)).toBe(true);
  });

  it('dims older Tier-3 rows', () => {
    expect(isQuiet(29)).toBe(true);
  });
});

describe('provenanceSegments', () => {
  it('orders segments follow → req → pick → sent with raw counts as grow', () => {
    expect(provenanceSegments({ req: 1, follow: 3, pick: 1, sent: 2 })).toEqual([
      { kind: 'follow', grow: 3 },
      { kind: 'req', grow: 1 },
      { kind: 'pick', grow: 1 },
      { kind: 'sent', grow: 2 },
    ]);
  });

  it('collapses zero-count segments to grow 0', () => {
    expect(provenanceSegments({ req: 0, follow: 5, pick: 0, sent: 0 })).toEqual([
      { kind: 'follow', grow: 5 },
      { kind: 'req', grow: 0 },
      { kind: 'pick', grow: 0 },
      { kind: 'sent', grow: 0 },
    ]);
  });

  it('reads a payload without a sent count as zero parent picks', () => {
    expect(provenanceSegments({ req: 1, follow: 0, pick: 0 }).at(-1)).toEqual({ kind: 'sent', grow: 0 });
  });
});

describe('moreCount', () => {
  it('returns overflow beyond the shown peek', () => {
    expect(moreCount(5, 3)).toBe(2);
  });

  it('is zero when everything is shown', () => {
    expect(moreCount(3, 3)).toBe(0);
  });

  it('never goes negative when shown exceeds count', () => {
    expect(moreCount(2, 3)).toBe(0);
  });
});

describe('agoLabel', () => {
  it('uses the plural day form within Tier 3', () => {
    expect(agoLabel(7)).toBe('7 days ago');
    expect(agoLabel(29)).toBe('29 days ago');
  });

  it('handles the today / yesterday edges for completeness', () => {
    expect(agoLabel(0)).toBe('today');
    expect(agoLabel(1)).toBe('yesterday');
  });
});

describe('itemsLabel', () => {
  it('pluralises correctly', () => {
    expect(itemsLabel(1)).toBe('1 item');
    expect(itemsLabel(5)).toBe('5 items');
    expect(itemsLabel(0)).toBe('0 items');
  });
});
