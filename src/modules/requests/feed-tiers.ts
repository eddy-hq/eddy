// Tier 3 / Tier 4 feed summaries (issue #140).
//
// The /feed payload keeps the existing `days` array (Tier 1 + Tier 2 — full
// rows for the most recent history) untouched, because Saved.tsx flatMaps over
// the entire `days` history to surface saved items. On top of that we add two
// additive, summary-shaped tiers for older history so the front-end can render
// progressively denser views the further back you scroll:
//
//   Tier 3 — per-day summaries for rows aged 7–29 days inclusive.
//   Tier 4 — per-week (ISO week, Monday–Sunday) summaries for rows aged ≥ 30.
//
// Age is measured in whole days: today's date minus the row's day (the day is
// `added_at` sliced to ISO date, falling back to `requested_at`, matching the
// existing handler). Rows aged < 7 days are left for `days` alone and never
// appear here. Empty days and weeks are omitted entirely.
//
// This module is pure: it takes already-fetched, already-day-sliced rows and a
// reference "today" date string, and returns plain data. No DB access, no
// clock reads beyond the caller-supplied `todayStr`, so it is exercised
// directly in unit tests.

/** Provenance bucket a feed row maps to, mirroring Feed.tsx `sourceKind()`. */
export type FeedKind = 'req' | 'follow' | 'pick';

/** Minimal row shape the tier grouping needs. */
export interface TierInputRow {
  /** ISO date 'YYYY-MM-DD' the row is grouped under (added_at ?? requested_at). */
  day: string;
  title: string | null;
  channel: string | null;
  source: string;
}

export interface Tier3Day {
  date: string;
  count: number;
  provenanceMix: { req: number; follow: number; pick: number };
  topTitles: Array<{ title: string; kind: FeedKind }>;
}

export interface Tier4Week {
  rangeStart: string;
  rangeEnd: string;
  count: number;
  topChannels: string[];
  /** Populated by the Gemma sub-issue (#143); intentionally null for now. */
  summary: string | null;
}

const DAY_MS = 86_400_000;
const TIER3_MIN_AGE_DAYS = 7;
const TIER4_MIN_AGE_DAYS = 30;
const MAX_TOP_TITLES = 3;
const MAX_TOP_CHANNELS = 3;

/**
 * Map a request `source` to a provenance kind, mirroring the PWA's
 * `sourceKind()` in Feed.tsx. Unknown sources (e.g. legacy 'search',
 * 'dns_landing') bucket to 'req' rather than crashing — they are user-initiated
 * acquisitions, so 'req' (the share-sheet / "you asked" bucket) is the closest
 * fit and keeps the provenance totals summing to `count`.
 */
export function sourceToKind(source: string): FeedKind {
  if (source === 'channel_subscription') return 'follow';
  if (source === 'recommended') return 'pick';
  // 'share_sheet' and any other/unknown source.
  return 'req';
}

/**
 * Whole-day age of a `day` ('YYYY-MM-DD') relative to `todayStr`. Computed at
 * UTC midnight on both sides so it is purely a calendar-day delta, immune to
 * the wall-clock time of day. A future-dated row yields a negative age.
 */
export function ageInDays(day: string, todayStr: string): number {
  const dayMs = Date.parse(day + 'T00:00:00Z');
  const todayMs = Date.parse(todayStr + 'T00:00:00Z');
  return Math.round((todayMs - dayMs) / DAY_MS);
}

/**
 * Monday-start ISO week the given date falls in, returned as the inclusive
 * `rangeStart` (Monday) / `rangeEnd` (Sunday) ISO date pair.
 */
export function isoWeekRange(day: string): { rangeStart: string; rangeEnd: string } {
  const ms = Date.parse(day + 'T00:00:00Z');
  const d = new Date(ms);
  // getUTCDay(): 0=Sun..6=Sat. Shift so Monday=0..Sunday=6.
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  const mondayMs = ms - mondayOffset * DAY_MS;
  const sundayMs = mondayMs + 6 * DAY_MS;
  return {
    rangeStart: new Date(mondayMs).toISOString().slice(0, 10),
    rangeEnd: new Date(sundayMs).toISOString().slice(0, 10),
  };
}

/**
 * Build Tier 3 (per-day) and Tier 4 (per-week) summaries from the full set of
 * day-sliced rows. `rows` must already be ordered most-recent-first (the feed
 * query's `added_at DESC`), which is what gives `topTitles` its
 * most-recent-first ordering within a day.
 */
export function buildTierSummaries(
  rows: TierInputRow[],
  todayStr: string,
): { tier3Days: Tier3Day[]; tier4Weeks: Tier4Week[] } {
  const tier3ByDate = new Map<string, TierInputRow[]>();
  const tier4ByWeek = new Map<string, { rangeStart: string; rangeEnd: string; rows: TierInputRow[] }>();

  for (const row of rows) {
    const age = ageInDays(row.day, todayStr);
    if (age >= TIER4_MIN_AGE_DAYS) {
      const { rangeStart, rangeEnd } = isoWeekRange(row.day);
      const existing = tier4ByWeek.get(rangeStart);
      if (existing) existing.rows.push(row);
      else tier4ByWeek.set(rangeStart, { rangeStart, rangeEnd, rows: [row] });
    } else if (age >= TIER3_MIN_AGE_DAYS) {
      if (!tier3ByDate.has(row.day)) tier3ByDate.set(row.day, []);
      tier3ByDate.get(row.day)!.push(row);
    }
    // age < 7: belongs to `days` (Tier 1+2) only.
  }

  const tier3Days: Tier3Day[] = Array.from(tier3ByDate.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // dates DESC (most recent first)
    .map(([date, dayRows]) => {
      const provenanceMix = { req: 0, follow: 0, pick: 0 };
      const topTitles: Array<{ title: string; kind: FeedKind }> = [];
      for (const row of dayRows) {
        const kind = sourceToKind(row.source);
        provenanceMix[kind] += 1;
        if (topTitles.length < MAX_TOP_TITLES && row.title) {
          topTitles.push({ title: row.title, kind });
        }
      }
      return { date, count: dayRows.length, provenanceMix, topTitles };
    });

  const tier4Weeks: Tier4Week[] = Array.from(tier4ByWeek.values())
    .sort((a, b) => (a.rangeStart < b.rangeStart ? 1 : -1)) // weeks DESC
    .map(({ rangeStart, rangeEnd, rows: weekRows }) => ({
      rangeStart,
      rangeEnd,
      count: weekRows.length,
      topChannels: topChannelsByCount(weekRows),
      summary: null,
    }));

  return { tier3Days, tier4Weeks };
}

/**
 * Up to {@link MAX_TOP_CHANNELS} channels for a week, ordered by item count
 * (descending), ties broken by first appearance — which, given most-recent-first
 * input, means the more recent channel wins a tie. Null/empty channels are
 * skipped.
 */
function topChannelsByCount(rows: TierInputRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const channel = row.channel;
    if (!channel) continue;
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1]) // Map preserves insertion order, so equal counts keep first-seen order.
    .slice(0, MAX_TOP_CHANNELS)
    .map(([channel]) => channel);
}
