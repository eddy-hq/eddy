export function uploadDateToIso(uploadDate: string | null): string | null {
  if (!uploadDate || uploadDate.length !== 8) return null;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`;
}

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
