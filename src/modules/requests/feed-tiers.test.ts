import { describe, expect, it } from 'vitest';
import {
  ageInDays,
  isoWeekRange,
  sourceToKind,
  buildTierSummaries,
  type TierInputRow,
} from './feed-tiers';

// Pure-logic coverage for the Tier 3 / Tier 4 grouping (issue #140). The
// router integration tests in router.test.ts exercise the full payload; these
// pin the boundary arithmetic and ordering rules directly, free of any clock or
// DB dependency.

describe('sourceToKind', () => {
  it('maps the three known sources mirroring Feed.tsx sourceKind()', () => {
    expect(sourceToKind('share_sheet')).toBe('req');
    expect(sourceToKind('channel_subscription')).toBe('follow');
    expect(sourceToKind('recommended')).toBe('pick');
  });

  it('maps a parent pick to its own sent bucket, never req (#217)', () => {
    expect(sourceToKind('parent_pick')).toBe('sent');
  });

  it('buckets unknown/legacy sources to req rather than throwing', () => {
    expect(sourceToKind('search')).toBe('req');
    expect(sourceToKind('dns_landing')).toBe('req');
    expect(sourceToKind('')).toBe('req');
  });
});

describe('ageInDays', () => {
  it('is a whole-day calendar delta, independent of time of day', () => {
    expect(ageInDays('2026-05-25', '2026-05-25')).toBe(0);
    expect(ageInDays('2026-05-24', '2026-05-25')).toBe(1);
    expect(ageInDays('2026-05-18', '2026-05-25')).toBe(7);
    expect(ageInDays('2026-04-25', '2026-05-25')).toBe(30);
  });

  it('is negative for a future-dated day', () => {
    expect(ageInDays('2026-05-26', '2026-05-25')).toBe(-1);
  });
});

describe('isoWeekRange', () => {
  it('returns the Monday–Sunday range for a midweek day', () => {
    // 2026-03-25 is a Wednesday; its ISO week is Mon 23 – Sun 29 Mar.
    expect(isoWeekRange('2026-03-25')).toEqual({ rangeStart: '2026-03-23', rangeEnd: '2026-03-29' });
  });

  it('treats Monday as the start of its own week', () => {
    expect(isoWeekRange('2026-03-23')).toEqual({ rangeStart: '2026-03-23', rangeEnd: '2026-03-29' });
  });

  it('treats Sunday as the end of the week that began the prior Monday', () => {
    expect(isoWeekRange('2026-03-29')).toEqual({ rangeStart: '2026-03-23', rangeEnd: '2026-03-29' });
  });

  it('spans a month boundary as a single week', () => {
    // 2026-03-30 (Mon) – 2026-04-05 (Sun) crosses March into April.
    expect(isoWeekRange('2026-04-01')).toEqual({ rangeStart: '2026-03-30', rangeEnd: '2026-04-05' });
  });
});

function row(day: string, source: string, title: string | null = null, channel: string | null = null): TierInputRow {
  return { day, source, title, channel };
}

const TODAY = '2026-05-25';

describe('buildTierSummaries', () => {
  it('routes rows by age: <7 → neither tier, 7–29 → tier3, ≥30 → tier4', () => {
    const rows: TierInputRow[] = [
      row('2026-05-25', 'share_sheet'), // age 0
      row('2026-05-19', 'share_sheet'), // age 6 → days only
      row('2026-05-18', 'share_sheet'), // age 7 → tier3
      row('2026-04-26', 'share_sheet'), // age 29 → tier3
      row('2026-04-25', 'channel_subscription', null, 'Ch'), // age 30 → tier4
    ];
    const { tier3Days, tier4Weeks } = buildTierSummaries(rows, TODAY);

    expect(tier3Days.map((d) => d.date)).toEqual(['2026-05-18', '2026-04-26']);
    expect(tier4Weeks).toHaveLength(1);
    expect(tier4Weeks[0]!.count).toBe(1);
  });

  it('returns empty arrays for no rows', () => {
    expect(buildTierSummaries([], TODAY)).toEqual({ tier3Days: [], tier4Weeks: [] });
  });

  it('builds tier3 provenanceMix and caps topTitles at 3, preserving input order', () => {
    // Input is most-recent-first (the feed query's added_at DESC); topTitles
    // takes the first 3 titled rows in that order.
    const rows: TierInputRow[] = [
      row('2026-05-15', 'share_sheet', 'A'),
      row('2026-05-15', 'recommended', 'B'),
      row('2026-05-15', 'channel_subscription', 'C'),
      row('2026-05-15', 'share_sheet', 'D'),
    ];
    const { tier3Days } = buildTierSummaries(rows, TODAY);
    expect(tier3Days).toHaveLength(1);
    const day = tier3Days[0]!;
    expect(day.count).toBe(4);
    expect(day.provenanceMix).toEqual({ req: 2, follow: 1, pick: 1, sent: 0 });
    expect(day.topTitles).toEqual([
      { title: 'A', kind: 'req' },
      { title: 'B', kind: 'pick' },
      { title: 'C', kind: 'follow' },
    ]);
  });

  it('counts parent picks as sent in the tier3 provenanceMix, not req (#217)', () => {
    const rows: TierInputRow[] = [
      row('2026-05-15', 'share_sheet', 'A'),
      row('2026-05-15', 'parent_pick', 'B'),
    ];
    const [day] = buildTierSummaries(rows, TODAY).tier3Days;
    expect(day!.provenanceMix).toEqual({ req: 1, follow: 0, pick: 0, sent: 1 });
    expect(day!.topTitles).toEqual([
      { title: 'A', kind: 'req' },
      { title: 'B', kind: 'sent' },
    ]);
  });

  it('skips null titles when filling topTitles but still counts them', () => {
    const rows: TierInputRow[] = [
      row('2026-05-15', 'share_sheet', null),
      row('2026-05-15', 'share_sheet', 'Has title'),
    ];
    const { tier3Days } = buildTierSummaries(rows, TODAY);
    const day = tier3Days[0]!;
    expect(day.count).toBe(2);
    expect(day.topTitles).toEqual([{ title: 'Has title', kind: 'req' }]);
  });

  it('groups tier4 rows into Monday–Sunday weeks with topChannels by count and null summary', () => {
    const rows: TierInputRow[] = [
      // All in week Mon 2026-04-20 – Sun 2026-04-26 (≥30d from 2026-05-25).
      row('2026-04-22', 'channel_subscription', null, 'X'),
      row('2026-04-23', 'channel_subscription', null, 'Y'),
      row('2026-04-24', 'channel_subscription', null, 'X'),
      row('2026-04-25', 'channel_subscription', null, 'Z'),
    ];
    const { tier4Weeks } = buildTierSummaries(rows, TODAY);
    expect(tier4Weeks).toHaveLength(1);
    const week = tier4Weeks[0]!;
    expect(week.rangeStart).toBe('2026-04-20');
    expect(week.rangeEnd).toBe('2026-04-26');
    expect(week.count).toBe(4);
    expect(week.topChannels).toEqual(['X', 'Y', 'Z']); // X=2 first, then Y, Z (first-seen tie order), capped at 3
    expect(week.summary).toBeNull();
  });

  it('omits null/empty channels from topChannels', () => {
    const rows: TierInputRow[] = [
      row('2026-04-22', 'channel_subscription', null, null),
      row('2026-04-22', 'channel_subscription', null, ''),
      row('2026-04-22', 'channel_subscription', null, 'Only'),
    ];
    const { tier4Weeks } = buildTierSummaries(rows, TODAY);
    expect(tier4Weeks[0]!.topChannels).toEqual(['Only']);
  });

  it('returns tier3 days in date-descending order and tier4 weeks in rangeStart-descending order', () => {
    const rows: TierInputRow[] = [
      row('2026-05-10', 'share_sheet', 'older t3'),
      row('2026-05-16', 'share_sheet', 'newer t3'),
      row('2026-03-10', 'channel_subscription', null, 'A'),
      row('2026-04-01', 'channel_subscription', null, 'B'),
    ];
    const { tier3Days, tier4Weeks } = buildTierSummaries(rows, TODAY);
    expect(tier3Days.map((d) => d.date)).toEqual(['2026-05-16', '2026-05-10']);
    expect(tier4Weeks.map((w) => w.rangeStart)).toEqual(
      [...tier4Weeks.map((w) => w.rangeStart)].sort((a, b) => (a < b ? 1 : -1)),
    );
    expect(tier4Weeks[0]!.rangeStart > tier4Weeks[1]!.rangeStart).toBe(true);
  });
});
