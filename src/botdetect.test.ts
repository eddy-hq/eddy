import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isBotDetectionError,
  engageBotDetectionCooldown,
  botDetectionCooldownMs,
  BOT_DETECTION_COOLDOWN_KEY,
  type CooldownStore,
} from './botdetect';

describe('isBotDetectionError', () => {
  it('matches the canonical YouTube bot-detection message', () => {
    expect(isBotDetectionError('ERROR: Sign in to confirm you’re not a bot')).toBe(true);
    expect(isBotDetectionError("Sign in to confirm you're not a bot")).toBe(true);
    expect(isBotDetectionError('Please sign in to view this video')).toBe(true);
  });

  it('matches even when buried in a multi-line yt-dlp stderr dump', () => {
    const stderr = [
      '[youtube] abc123: Downloading webpage',
      'ERROR: [youtube] abc123: Sign in to confirm you’re not a bot. Use --cookies-from-browser',
    ].join('\n');
    expect(isBotDetectionError(stderr)).toBe(true);
  });

  it('does not match unrelated terminal errors', () => {
    expect(isBotDetectionError('ERROR: Video unavailable')).toBe(false);
    expect(isBotDetectionError('ERROR: This video is private')).toBe(false);
    expect(isBotDetectionError('yt-dlp exited with code 1\nHTTP Error 416')).toBe(false);
  });

  it('is false for empty / null / undefined', () => {
    expect(isBotDetectionError('')).toBe(false);
    expect(isBotDetectionError(null)).toBe(false);
    expect(isBotDetectionError(undefined)).toBe(false);
  });
});

// In-memory fake implementing just the slice botdetect uses. `ttl` is the value
// pttl returns; tests set it directly to simulate an armed / expired key.
function fakeStore(): CooldownStore & { calls: Array<[string, string, string, number]>; ttl: number } {
  return {
    calls: [],
    ttl: -2,
    async set(key, value, exMode, seconds) {
      this.calls.push([key, value, exMode, seconds]);
      // Mimic SET EX: a positive TTL becomes readable by pttl.
      this.ttl = seconds * 1000;
      return 'OK';
    },
    async pttl() {
      return this.ttl;
    },
  };
}

describe('engageBotDetectionCooldown', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes the cooldown key with the configured TTL', async () => {
    const store = fakeStore();
    await engageBotDetectionCooldown(store, 2700, 'download');
    expect(store.calls).toEqual([[BOT_DETECTION_COOLDOWN_KEY, 'download', 'EX', 2700]]);
  });

  it('is a no-op when the cooldown is disabled (secs <= 0)', async () => {
    const store = fakeStore();
    await engageBotDetectionCooldown(store, 0, 'download');
    expect(store.calls).toEqual([]);
  });

  it('swallows Redis errors (fail-open) rather than throwing', async () => {
    const store: CooldownStore = {
      set: vi.fn().mockRejectedValue(new Error('NOAUTH')),
      pttl: vi.fn(),
    };
    await expect(engageBotDetectionCooldown(store, 2700, 'search')).resolves.toBeUndefined();
  });
});

describe('botDetectionCooldownMs', () => {
  it('returns the remaining ms when a cooldown is armed', async () => {
    const store = fakeStore();
    await engageBotDetectionCooldown(store, 60, 'search');
    expect(await botDetectionCooldownMs(store)).toBe(60_000);
  });

  it('returns 0 when no key is set (pttl -2) or no expiry (pttl -1)', async () => {
    const store = fakeStore();
    store.ttl = -2;
    expect(await botDetectionCooldownMs(store)).toBe(0);
    store.ttl = -1;
    expect(await botDetectionCooldownMs(store)).toBe(0);
  });

  it('returns 0 on Redis error (fail-open)', async () => {
    const store: CooldownStore = {
      set: vi.fn(),
      pttl: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    expect(await botDetectionCooldownMs(store)).toBe(0);
  });
});
