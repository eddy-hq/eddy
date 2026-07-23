// Canonical implementation lives in the pure date helper (src/date.ts) so the
// content download path can share it without importing the discovery barrel.
// Re-exported here to keep discovery's existing callers and tests on the same
// import.
export { uploadDateToIso } from '../../date';

export function daysSince(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function formatAge(isoDate: string | null): string {
  const days = daysSince(isoDate);
  if (days === null) return 'unknown age';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatDuration(secs: number | null): string {
  if (secs === null || secs <= 0) return 'unknown length';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

// Resolve after `ms` (immediate for ms <= 0). Used to space discovery's yt-dlp
// fan-out so it drips rather than bursting into the shared IP (#185).
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Base delay plus a random 0..jitter, both ms. RNG is injectable so the spacing
// is unit-testable without depending on Math.random. Negative inputs clamp to 0.
export function jitteredDelayMs(baseMs: number, jitterMs: number, rng: () => number = Math.random): number {
  const base = baseMs > 0 ? baseMs : 0;
  const jitter = jitterMs > 0 ? Math.floor(rng() * jitterMs) : 0;
  return base + jitter;
}

export interface ScheduledUser {
  userId: string;
  hour: number;
}

// Pure schedule builder for the per-user discovery crons (#185). Each eligible
// user composes their daily slate at their own hour so the fleet's yt-dlp
// search + download volume spreads across the day instead of one 06:00 spike
// from the shared residential IP. A user with no configured hour falls back to
// defaultHour. `pollHour` is the earliest user hour — the channel-wide RSS poll
// is scheduled there so it runs before any user composes. Users are sorted by
// hour (ties broken by id) for stable, readable startup logs.
export function buildDiscoverySchedule(
  userIds: readonly string[],
  hourByUser: Readonly<Record<string, number>>,
  defaultHour: number,
): { pollHour: number; users: ScheduledUser[] } {
  const users = userIds
    .map((userId) => ({ userId, hour: hourByUser[userId] ?? defaultHour }))
    .sort((a, b) => a.hour - b.hour || a.userId.localeCompare(b.userId));
  const pollHour = users.length > 0 ? users[0]!.hour : defaultHour;
  return { pollHour, users };
}

// Daily cron pattern (BullMQ `repeat.pattern`) firing every day at hour:minute.
export function cronAt(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

// Start-of-UTC-day as an ISO 8601 string, matching the shape requests writes to
// `requested_at` (`new Date().toISOString()`). A lexical `requested_at >= this`
// therefore selects every download that entered today. The global download
// budget (ADR-0012) counts against the UTC day, not local time, so a per-user
// slate run at any hour spends against one shared, day-aligned tally.
export function utcDayStartIso(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// Pure planner for the global daily download budget (ADR-0012). Splits an
// already-picked set of automated candidates into the ones to download now and
// the ones to defer, given the remaining budget for the UTC day.
//
// Spend priority: slate-bound (delighter) picks are funded before follow-sourced
// (subscription / back-catalogue) picks. Ordering is otherwise stable, so a
// weighted-desc input stays weighted-desc within each priority group. Deferred
// picks are not failures — the caller leaves them re-selectable for a later day.
export interface DownloadBudgetPlan<T> {
  toDownload: T[];
  toDefer: T[];
}

export function planAutomatedDownloads<T>(
  picks: readonly T[],
  isSlateBound: (pick: T) => boolean,
  remaining: number,
): DownloadBudgetPlan<T> {
  const ordered = [
    ...picks.filter((p) => isSlateBound(p)),
    ...picks.filter((p) => !isSlateBound(p)),
  ];
  const budget = Math.max(0, Math.floor(remaining));
  return {
    toDownload: ordered.slice(0, budget),
    toDefer: ordered.slice(budget),
  };
}

// Automated-download allowance for one user's slate run (ADR-0012, 2026-07-23
// amendment). Bounded by BOTH the fleet-wide daily ceiling (bot-detection volume
// guard) and the per-user daily cap (fairness — a heavy-follow user whose slate
// job fires early must not drain the shared pool before later-scheduled users,
// e.g. the kids, get their turn). The tighter of the two governs. Result may be
// negative or fractional; planAutomatedDownloads floors and clamps it.
export function automatedDownloadAllowance(
  globalBudget: number,
  globalSpent: number,
  perUserBudget: number,
  perUserSpent: number,
): number {
  return Math.min(globalBudget - globalSpent, perUserBudget - perUserSpent);
}
