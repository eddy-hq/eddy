import { describe, it, expect, vi } from 'vitest';

// Keep module load free of real Redis / config / notifications — same harness shape as
// circuit-breaker.test.ts. The unit under test takes its I/O via injected deps.
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./queue', () => ({
  redis: { incr: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
vi.mock('./config', () => ({
  config: { USER_ID_STEVE: 'steve-uuid', DOWNLOAD_FAILURE_STREAK_THRESHOLD: 5 },
}));
vi.mock('./modules/notifications', () => ({ getNotifications: vi.fn() }));

import {
  shouldAlertOnStreak,
  summariseError,
  recordDownloadFailure,
  recordDownloadSuccess,
  type FailureStreakDeps,
} from './failure-streak';

const THRESHOLD = 5; // mirrors the mocked config above

describe('shouldAlertOnStreak', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(shouldAlertOnStreak(THRESHOLD - 1, THRESHOLD)).toBe(false);
    expect(shouldAlertOnStreak(THRESHOLD, THRESHOLD)).toBe(true);
    // `>=` so a lost claim-race or failed send can be retried by the next
    // failure in the same streak.
    expect(shouldAlertOnStreak(THRESHOLD + 3, THRESHOLD)).toBe(true);
  });
});

describe('summariseError', () => {
  it('takes the first non-empty line and caps the length', () => {
    expect(summariseError('yt-dlp exited with code 1\nERROR: 403')).toBe(
      'yt-dlp exited with code 1',
    );
    expect(summariseError('\n\nERROR: HTTP Error 403: Forbidden\nstack…')).toBe(
      'ERROR: HTTP Error 403: Forbidden',
    );
    expect(summariseError('x'.repeat(500)).length).toBe(200);
    expect(summariseError('')).toBe('');
  });
});

function makeDeps(count: number, overrides: Partial<FailureStreakDeps> = {}): FailureStreakDeps {
  return {
    incrementStreak: vi.fn(async () => count),
    clearStreak: vi.fn(async () => {}),
    claimAlert: vi.fn(async () => true),
    releaseAlert: vi.fn(async () => {}),
    sendAlert: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('recordDownloadFailure', () => {
  it('does not alert below the threshold', async () => {
    const deps = makeDeps(THRESHOLD - 1);
    const alerted = await recordDownloadFailure('ERROR: 403', deps);
    expect(alerted).toBe(false);
    expect(deps.claimAlert).not.toHaveBeenCalled();
    expect(deps.sendAlert).not.toHaveBeenCalled();
  });

  it('alerts once when the streak reaches the threshold', async () => {
    const deps = makeDeps(THRESHOLD);
    const alerted = await recordDownloadFailure(
      'yt-dlp exited with code 1\nERROR: unable to download video data: HTTP Error 403: Forbidden',
      deps,
    );
    expect(alerted).toBe(true);
    expect(deps.sendAlert).toHaveBeenCalledWith(THRESHOLD, 'yt-dlp exited with code 1');
  });

  it('stays quiet past the threshold when the claim is already held', async () => {
    const deps = makeDeps(THRESHOLD + 4, { claimAlert: vi.fn(async () => false) });
    const alerted = await recordDownloadFailure('ERROR: 403', deps);
    expect(alerted).toBe(false);
    expect(deps.sendAlert).not.toHaveBeenCalled();
  });

  it('releases the claim when the send fails, so a later failure can retry', async () => {
    const deps = makeDeps(THRESHOLD, {
      sendAlert: vi.fn(async () => { throw new Error('notify failed'); }),
    });
    const alerted = await recordDownloadFailure('ERROR: 403', deps);
    expect(alerted).toBe(false); // fail-open
    expect(deps.releaseAlert).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis is unavailable', async () => {
    const deps = makeDeps(0, {
      incrementStreak: vi.fn(async () => { throw new Error('redis down'); }),
    });
    await expect(recordDownloadFailure('ERROR: 403', deps)).resolves.toBe(false);
  });
});

describe('recordDownloadSuccess', () => {
  it('clears the streak and the alert claim', async () => {
    const deps = makeDeps(0);
    await recordDownloadSuccess(deps);
    expect(deps.clearStreak).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis is unavailable', async () => {
    const deps = makeDeps(0, {
      clearStreak: vi.fn(async () => { throw new Error('redis down'); }),
    });
    await expect(recordDownloadSuccess(deps)).resolves.toBeUndefined();
  });
});
