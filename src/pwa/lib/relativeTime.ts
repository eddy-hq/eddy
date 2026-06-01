// Pure relative-time formatting for the Today cards (issue #186). Extracted out
// of Card.tsx so it can be unit-tested in the node Vitest env (src/**/*.test.ts)
// without dragging React/Framer Motion into the suite.
//
// The feed shows a video's publish date, which can be years old for a
// back-catalogue pull — so the scale widens past days into weeks, months and
// years rather than capping at "1278d ago". Month/year buckets use 30- and
// 365-day approximations: this is a glanceable "how old" pill, not a precise
// calendar diff, so exact month lengths don't matter.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// `now` is injectable so tests are deterministic without mocking Date.
export function relativeTimeAgo(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  // Future timestamps (clock skew between the M4 and the device) read as "just
  // now" rather than a negative count.
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}w ago`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo ago`;
  return `${Math.floor(diff / YEAR)}y ago`;
}
