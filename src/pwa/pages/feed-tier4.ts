// Pure logic for the Feed Tier 4 week-row (issue #142). The `WeekRow` and
// month-marker components stay thin and consume these helpers; everything
// testable lives here so it can be covered under the node-env Vitest harness
// (the PWA has no jsdom/RTL).
//
// A Tier 4 week (age ≥ 30 days) is described by the additive `tier4Weeks`
// payload (#140): an ISO-week range (`rangeStart` Monday … `rangeEnd` Sunday,
// both 'YYYY-MM-DD'), a `count`, up to three `topChannels`, and a cached
// editorial `summary` (#143) that may be null.

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

interface YMD {
  year: number;
  /** 0-based month index (0 = January). */
  month: number;
  day: number;
}

/**
 * Parse a 'YYYY-MM-DD' date string into its calendar parts. Parsed positionally
 * (not via `Date`) so the result is timezone-agnostic — a Tier 4 range is a pure
 * calendar label and must never shift across a local-midnight offset.
 */
export function parseYmd(date: string): YMD {
  const [year, month, day] = date.split('-').map((p) => parseInt(p, 10));
  return { year, month: month - 1, day };
}

/**
 * Format an ISO-week range for the week-row's range line. Mirrors the
 * prototype: same month collapses the first month name ("23 – 29 Mar"); a
 * cross-month range repeats it ("30 Mar – 5 Apr"); a cross-year range appends
 * each side's year so a Dec–Jan boundary reads unambiguously
 * ("29 Dec 2025 – 4 Jan 2026") rather than silently dropping the year.
 *
 * Uses an en dash with hairline spaces matching the prototype glyphs.
 */
export function formatWeekRange(rangeStart: string, rangeEnd: string): string {
  const a = parseYmd(rangeStart);
  const b = parseYmd(rangeEnd);

  if (a.year !== b.year) {
    return `${a.day} ${MONTHS_SHORT[a.month]} ${a.year} – ${b.day} ${MONTHS_SHORT[b.month]} ${b.year}`;
  }
  if (a.month !== b.month) {
    return `${a.day} ${MONTHS_SHORT[a.month]} – ${b.day} ${MONTHS_SHORT[b.month]}`;
  }
  // Same month and year: collapse the first month name.
  return `${a.day} – ${b.day} ${MONTHS_SHORT[b.month]}`;
}

/** "5 items" / "1 item" — count label with correct pluralisation. */
export function itemsLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Resolve the week-row summary line. The cached Gemma editorial line (#143) is
 * preferred; when it is null, empty, or whitespace-only the row degrades to the
 * "{count} items" fallback so the line is never blank and never reads "null".
 */
export function resolveSummary(summary: string | null | undefined, count: number): string {
  const trimmed = summary?.trim();
  return trimmed ? trimmed : itemsLabel(count);
}

/**
 * Month-marker label for a divider that sits *above* the given week's row. The
 * grouping basis is the week's `rangeStart` month (the Monday of the ISO week),
 * documented so client and any future server marker stay aligned. The year is
 * appended only when it differs from `currentYear`, to disambiguate (e.g. last
 * December's "December 2025" against this year's months) without cluttering the
 * common same-year case.
 */
export function monthMarkerLabel(rangeStart: string, currentYear: number): string {
  const { year, month } = parseYmd(rangeStart);
  const name = MONTHS_LONG[month];
  return year === currentYear ? name : `${name} ${year}`;
}

export interface WeekMarker {
  /** Index into the DESC week list — the marker renders immediately above this week. */
  beforeIndex: number;
  label: string;
}

/**
 * Compute where month-marker dividers go in a newest-first (rangeStart-DESC)
 * list of Tier 4 weeks. A marker is inserted between two consecutive weeks
 * whenever the calendar month (by `rangeStart`) changes from one to the next.
 *
 * Crucially there is **no marker above the first week** (no leading orphan
 * label): markers only mark a *transition* between two rendered weeks, so the
 * first week never gets one. A single-week (or empty) list yields no markers.
 *
 * The label is the month of the week *below* the divider (the older week that
 * begins the new month block, since the list runs newest-first), matching the
 * prototype where "March" heads the run of March weeks.
 */
export function weekMonthMarkers(
  weeks: ReadonlyArray<{ rangeStart: string }>,
  currentYear: number,
): WeekMarker[] {
  const markers: WeekMarker[] = [];
  for (let i = 1; i < weeks.length; i++) {
    const prev = parseYmd(weeks[i - 1].rangeStart);
    const curr = parseYmd(weeks[i].rangeStart);
    if (prev.year !== curr.year || prev.month !== curr.month) {
      markers.push({ beforeIndex: i, label: monthMarkerLabel(weeks[i].rangeStart, currentYear) });
    }
  }
  return markers;
}

/** Set of week indices that have a month-marker above them, for O(1) lookup in render. */
export function markersByIndex(markers: ReadonlyArray<WeekMarker>): Map<number, string> {
  return new Map(markers.map((m) => [m.beforeIndex, m.label]));
}
