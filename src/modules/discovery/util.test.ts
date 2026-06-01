import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  uploadDateToIso,
  daysSince,
  formatAge,
  formatDuration,
  sleep,
  jitteredDelayMs,
  buildDiscoverySchedule,
  cronAt,
} from './util';

describe('uploadDateToIso', () => {
  it('converts a valid 8-char yt-dlp upload_date to ISO', () => {
    expect(uploadDateToIso('20260315')).toBe('2026-03-15T00:00:00.000Z');
  });

  it('returns null for null input', () => {
    expect(uploadDateToIso(null)).toBeNull();
  });

  it('returns null for wrong length', () => {
    expect(uploadDateToIso('2026-03-15')).toBeNull();
    expect(uploadDateToIso('202603')).toBeNull();
  });

  it('returns null for an eight-char value that is not a real date', () => {
    expect(uploadDateToIso('abcdefgh')).toBeNull();
    expect(uploadDateToIso('20261340')).toBeNull();
    expect(uploadDateToIso('20260230')).toBeNull();
  });
});

describe('daysSince', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when the input is null', () => {
    expect(daysSince(null)).toBeNull();
  });

  it('floors the day diff for an older date', () => {
    expect(daysSince('2026-04-20T00:00:00.000Z')).toBe(5);
  });

  it('returns 0 for the same calendar moment', () => {
    expect(daysSince('2026-04-25T00:00:00.000Z')).toBe(0);
  });
});

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "unknown age" for null', () => {
    expect(formatAge(null)).toBe('unknown age');
  });

  it('returns "today" for <1 day', () => {
    expect(formatAge('2026-04-25T06:00:00.000Z')).toBe('today');
  });

  it('returns "yesterday" for 1 day ago', () => {
    expect(formatAge('2026-04-24T06:00:00.000Z')).toBe('yesterday');
  });

  it('returns days for <7 days', () => {
    expect(formatAge('2026-04-21T12:00:00.000Z')).toBe('4d ago');
  });

  it('returns weeks for <30 days', () => {
    expect(formatAge('2026-04-10T12:00:00.000Z')).toBe('2w ago');
  });

  it('returns months for >=30 days', () => {
    expect(formatAge('2026-01-25T12:00:00.000Z')).toBe('3mo ago');
  });
});

describe('formatDuration', () => {
  it('returns "unknown length" for null or non-positive', () => {
    expect(formatDuration(null)).toBe('unknown length');
    expect(formatDuration(0)).toBe('unknown length');
    expect(formatDuration(-30)).toBe('unknown length');
  });

  it('formats seconds under a minute', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats whole minutes under an hour', () => {
    expect(formatDuration(125)).toBe('2m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe('3h25m');
  });

  it('formats whole hours without trailing 0m', () => {
    expect(formatDuration(2 * 3600)).toBe('2h');
  });
});

describe('jitteredDelayMs (#185 search spacing)', () => {
  it('returns the base delay when jitter is 0', () => {
    expect(jitteredDelayMs(2000, 0)).toBe(2000);
  });

  it('adds floor(rng() * jitter) to the base', () => {
    expect(jitteredDelayMs(2000, 2000, () => 0.5)).toBe(3000);
    expect(jitteredDelayMs(2000, 2000, () => 0)).toBe(2000);
    expect(jitteredDelayMs(2000, 2000, () => 0.999)).toBe(3998);
  });

  it('clamps negative base / jitter to 0', () => {
    expect(jitteredDelayMs(-100, 0)).toBe(0);
    expect(jitteredDelayMs(0, -100, () => 0.5)).toBe(0);
  });
});

describe('cronAt', () => {
  it('builds a daily cron pattern at hour:minute', () => {
    expect(cronAt(6, 0)).toBe('0 6 * * *');
    expect(cronAt(14, 10)).toBe('10 14 * * *');
    expect(cronAt(0, 0)).toBe('0 0 * * *');
  });
});

describe('buildDiscoverySchedule (#185 per-user hours)', () => {
  const STEVE = 'aaaaaaaa-0000-0000-0000-000000000000';
  const BOY1 = 'bbbbbbbb-0000-0000-0000-000000000000';
  const BOY2 = 'cccccccc-0000-0000-0000-000000000000';
  const hours = { [STEVE]: 6, [BOY1]: 14, [BOY2]: 10 };

  it('assigns each user its configured hour, sorted by hour', () => {
    const { users } = buildDiscoverySchedule([STEVE, BOY1, BOY2], hours, 6);
    expect(users).toEqual([
      { userId: STEVE, hour: 6 },
      { userId: BOY2, hour: 10 },
      { userId: BOY1, hour: 14 },
    ]);
  });

  it('sets pollHour to the earliest user hour', () => {
    expect(buildDiscoverySchedule([STEVE, BOY1, BOY2], hours, 6).pollHour).toBe(6);
    // Earliest user is the one configured latest-named — pollHour tracks the min.
    expect(buildDiscoverySchedule([BOY1, BOY2], hours, 9).pollHour).toBe(10);
  });

  it('falls back to defaultHour for an unconfigured user', () => {
    const extra = 'dddddddd-0000-0000-0000-000000000000';
    const { users, pollHour } = buildDiscoverySchedule([STEVE, extra], hours, 6);
    expect(users).toEqual([
      { userId: STEVE, hour: 6 },
      { userId: extra, hour: 6 },
    ]);
    expect(pollHour).toBe(6);
  });

  it('breaks hour ties by userId for stable ordering', () => {
    const { users } = buildDiscoverySchedule([BOY2, STEVE], { [STEVE]: 8, [BOY2]: 8 }, 6);
    expect(users.map((u) => u.userId)).toEqual([STEVE, BOY2]);
  });

  it('returns defaultHour as pollHour when there are no users', () => {
    expect(buildDiscoverySchedule([], hours, 7)).toEqual({ pollHour: 7, users: [] });
  });
});

describe('sleep', () => {
  it('resolves immediately for ms <= 0 (no timer)', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-5)).resolves.toBeUndefined();
  });

  it('resolves after the timer for ms > 0', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = sleep(1000).then(() => { done = true; });
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
