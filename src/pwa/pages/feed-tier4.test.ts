import { describe, expect, it } from 'vitest';
import {
  cardsForWeekRange,
  formatWeekRange,
  itemsLabel,
  markersByIndex,
  monthMarkerLabel,
  parseYmd,
  resolveSummary,
  weekMonthMarkers,
} from './feed-tier4';

const CURRENT_YEAR = 2026;

describe('parseYmd', () => {
  it('parses positionally with a 0-based month, timezone-agnostic', () => {
    expect(parseYmd('2026-03-23')).toEqual({ year: 2026, month: 2, day: 23 });
    expect(parseYmd('2025-12-29')).toEqual({ year: 2025, month: 11, day: 29 });
    expect(parseYmd('2026-01-04')).toEqual({ year: 2026, month: 0, day: 4 });
  });
});

describe('formatWeekRange', () => {
  it('collapses the first month name for a same-month range', () => {
    expect(formatWeekRange('2026-03-23', '2026-03-29')).toBe('23 – 29 Mar');
  });

  it('repeats the month name when the range crosses months', () => {
    expect(formatWeekRange('2026-03-30', '2026-04-05')).toBe('30 Mar – 5 Apr');
  });

  it('appends both years when the range crosses a year boundary (Dec–Jan)', () => {
    expect(formatWeekRange('2025-12-29', '2026-01-04')).toBe('29 Dec 2025 – 4 Jan 2026');
  });
});

describe('itemsLabel', () => {
  it('pluralises correctly', () => {
    expect(itemsLabel(1)).toBe('1 item');
    expect(itemsLabel(38)).toBe('38 items');
    expect(itemsLabel(0)).toBe('0 items');
  });
});

describe('resolveSummary', () => {
  it('uses the editorial summary when present', () => {
    expect(resolveSummary('mostly Minecraft, a run of Steve Mould', 38)).toBe(
      'mostly Minecraft, a run of Steve Mould',
    );
  });

  it('falls back to the items label when summary is null', () => {
    expect(resolveSummary(null, 38)).toBe('38 items');
  });

  it('falls back when summary is undefined', () => {
    expect(resolveSummary(undefined, 12)).toBe('12 items');
  });

  it('falls back when summary is empty or whitespace-only — never blank, never "null"', () => {
    expect(resolveSummary('', 5)).toBe('5 items');
    expect(resolveSummary('   ', 5)).toBe('5 items');
  });

  it('trims surrounding whitespace from a real summary', () => {
    expect(resolveSummary('  a quiet week  ', 3)).toBe('a quiet week');
  });
});

describe('monthMarkerLabel', () => {
  it('uses the long month name with no year when the week is in the current year', () => {
    expect(monthMarkerLabel('2026-03-23', CURRENT_YEAR)).toBe('March');
    expect(monthMarkerLabel('2026-02-02', CURRENT_YEAR)).toBe('February');
  });

  it('appends the year to disambiguate a week from another year', () => {
    expect(monthMarkerLabel('2025-12-29', CURRENT_YEAR)).toBe('December 2025');
  });

  it('groups by the week rangeStart month, not the end', () => {
    // Week starts in March even though it ends in April.
    expect(monthMarkerLabel('2026-03-30', CURRENT_YEAR)).toBe('March');
  });
});

describe('weekMonthMarkers', () => {
  it('inserts a marker between two consecutive weeks whose month changes', () => {
    const weeks = [
      { rangeStart: '2026-03-30' }, // March
      { rangeStart: '2026-02-23' }, // February — month change here
      { rangeStart: '2026-02-16' }, // February — no change
    ];
    expect(weekMonthMarkers(weeks, CURRENT_YEAR)).toEqual([
      { beforeIndex: 1, label: 'February' },
    ]);
  });

  it('never inserts a marker above the first week (no leading orphan label)', () => {
    const weeks = [
      { rangeStart: '2026-03-23' },
      { rangeStart: '2026-03-16' },
      { rangeStart: '2026-03-09' },
    ];
    // All March → no markers at all, and certainly none at index 0.
    const markers = weekMonthMarkers(weeks, CURRENT_YEAR);
    expect(markers).toEqual([]);
    expect(markers.some((m) => m.beforeIndex === 0)).toBe(false);
  });

  it('returns no markers for a single-week list', () => {
    expect(weekMonthMarkers([{ rangeStart: '2026-03-23' }], CURRENT_YEAR)).toEqual([]);
  });

  it('returns no markers for an empty list', () => {
    expect(weekMonthMarkers([], CURRENT_YEAR)).toEqual([]);
  });

  it('treats a year change as a month change and labels with the year', () => {
    const weeks = [
      { rangeStart: '2026-01-05' }, // January 2026
      { rangeStart: '2025-12-29' }, // December 2025 — year + month change
    ];
    expect(weekMonthMarkers(weeks, CURRENT_YEAR)).toEqual([
      { beforeIndex: 1, label: 'December 2025' },
    ]);
  });

  it('inserts a marker each time the month changes across a longer run', () => {
    const weeks = [
      { rangeStart: '2026-03-30' }, // March
      { rangeStart: '2026-03-23' }, // March
      { rangeStart: '2026-02-23' }, // February — change
      { rangeStart: '2026-01-26' }, // January — change
    ];
    expect(weekMonthMarkers(weeks, CURRENT_YEAR)).toEqual([
      { beforeIndex: 2, label: 'February' },
      { beforeIndex: 3, label: 'January' },
    ]);
  });
});

describe('markersByIndex', () => {
  it('maps beforeIndex → label for O(1) lookup in render', () => {
    const map = markersByIndex([
      { beforeIndex: 2, label: 'February' },
      { beforeIndex: 3, label: 'January' },
    ]);
    expect(map.get(2)).toBe('February');
    expect(map.get(3)).toBe('January');
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(false);
  });
});

describe('cardsForWeekRange', () => {
  const days = [
    { date: '2025-05-12', cards: [{ id: 'd' }] },               // outside (after end)
    { date: '2025-05-11', cards: [{ id: 'c' }] },               // Sunday, inside
    { date: '2025-05-07', cards: [{ id: 'b1' }, { id: 'b2' }] }, // inside
    { date: '2025-05-05', cards: [{ id: 'a' }] },               // Monday, inside
    { date: '2025-05-04', cards: [{ id: 'z' }] },               // outside (before start)
  ];

  it('collects only cards whose day is within the inclusive range, newest-first', () => {
    const out = cardsForWeekRange(days, '2025-05-05', '2025-05-11');
    expect(out.map((c) => c.id)).toEqual(['c', 'b1', 'b2', 'a']);
  });

  it('returns [] when no day falls in the range (history beyond FEED_LIMIT)', () => {
    expect(cardsForWeekRange(days, '2025-01-06', '2025-01-12')).toEqual([]);
  });

  it('flattens sections when a day carries them instead of flat cards', () => {
    const withSections = [
      { date: '2025-05-07', cards: [] as Array<{ id: string }>, sections: [{ cards: [{ id: 's1' }] }, { cards: [{ id: 's2' }] }] },
    ];
    const out = cardsForWeekRange(withSections, '2025-05-05', '2025-05-11');
    expect(out.map((c) => c.id)).toEqual(['s1', 's2']);
  });
});
