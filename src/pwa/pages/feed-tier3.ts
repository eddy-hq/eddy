// Pure logic for the Feed Tier 3 day-row (issue #141). The `DayRow` component
// stays thin and consumes these helpers; everything testable lives here so it
// can be covered under the node-env Vitest harness (the PWA has no jsdom/RTL).

export type ProvenanceKind = 'req' | 'follow' | 'pick';

export interface ProvenanceMix {
  req: number;
  follow: number;
  pick: number;
}

// ── Tier boundaries ──────────────────────────────────────────────────────────
// Kept in lockstep with the server's bucketing (src/modules/requests/feed-tiers.ts):
// age < 7 → Tier 1/2 (`days`), 7–29 → Tier 3, ≥ 30 → Tier 4.
export const TIER2_MAX_AGE_DAYS = 6; // Tier 2 covers ages 0–6 (today excluded by caller)
export const TIER3_MIN_AGE_DAYS = 7;
export const TIER3_MAX_AGE_DAYS = 29;
// Within Tier 3, rows this old or older dim to the "quiet" variant.
export const QUIET_MIN_AGE_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * Whole-day age of a `day` ('YYYY-MM-DD') relative to `todayStr` (also
 * 'YYYY-MM-DD'). Computed at UTC midnight on both sides so it is a pure
 * calendar-day delta, immune to wall-clock time of day — mirrors the server's
 * `ageInDays` so client and server bucket identically. Future dates go negative.
 */
export function ageInDays(day: string, todayStr: string): number {
  const dayMs = Date.parse(day + 'T00:00:00Z');
  const todayMs = Date.parse(todayStr + 'T00:00:00Z');
  return Math.round((todayMs - dayMs) / DAY_MS);
}

/** A day belongs to Tier 2 (recent past, compact cards) when 0 ≤ age < 7. */
export function isTier2Age(age: number): boolean {
  return age >= 0 && age <= TIER2_MAX_AGE_DAYS;
}

/** A day belongs to Tier 3 (collapsed day-row) when 7 ≤ age ≤ 29. */
export function isTier3Age(age: number): boolean {
  return age >= TIER3_MIN_AGE_DAYS && age <= TIER3_MAX_AGE_DAYS;
}

/** Tier-3 rows aged ≥ 14 days dim to the quiet variant. */
export function isQuiet(age: number): boolean {
  return age >= QUIET_MIN_AGE_DAYS;
}

/**
 * Flex-grow weights for the vertical provenance bar, in render order
 * follow → req → pick (top → bottom, matching the prototype). Each segment's
 * grow value is its raw count; segments with a zero count collapse to grow 0
 * (no slither). When every count is zero (shouldn't happen for a real day) the
 * bar renders as the empty track.
 */
export function provenanceSegments(
  mix: ProvenanceMix,
): Array<{ kind: ProvenanceKind; grow: number }> {
  return [
    { kind: 'follow', grow: mix.follow },
    { kind: 'req', grow: mix.req },
    { kind: 'pick', grow: mix.pick },
  ];
}

/**
 * How many "+ N more" items sit beyond the shown title peek. `count` is the
 * day's total item count; `shown` is how many peek titles were rendered. Never
 * negative (guards against a topTitles list longer than count, or short days).
 */
export function moreCount(count: number, shown: number): number {
  return Math.max(0, count - shown);
}

/**
 * Human "ago" string for a Tier-3 day. Within Tier 3 the age is always ≥ 7, so
 * this only ever emits the plural day form ("7 days ago"); the singular and
 * "today"/"yesterday" forms are handled by Tier 1/2 and never reach here, but
 * we still special-case them so the helper is correct for any input.
 */
export function agoLabel(age: number): string {
  if (age <= 0) return 'today';
  if (age === 1) return 'yesterday';
  return `${age} days ago`;
}

/** "5 items" / "1 item" — count label with correct pluralisation. */
export function itemsLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
