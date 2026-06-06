import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isBotDetectionError,
  isRateLimitError,
  shouldEngageCooldown,
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

describe('isRateLimitError', () => {
  it('matches yt-dlp 429 / Too Many Requests output', () => {
    expect(isRateLimitError('ERROR: unable to download: HTTP Error 429: Too Many Requests')).toBe(true);
    expect(isRateLimitError('HTTP Error 429')).toBe(true);
    expect(isRateLimitError('YouTube said: rate-limited, try later')).toBe(true);
    expect(isRateLimitError('rate limiting in effect')).toBe(true);
  });

  it('does not match the bot-detection wall or unrelated HTTP errors', () => {
    // 429 is a soft throttle, not the "prove you're human" challenge — kept
    // distinct so each predicate stays single-purpose.
    expect(isRateLimitError("Sign in to confirm you're not a bot")).toBe(false);
    // 416 (stale-resume) must NOT arm the cooldown — only 429 does.
    expect(isRateLimitError('yt-dlp exited with code 1\nHTTP Error 416')).toBe(false);
    expect(isRateLimitError('ERROR: Video unavailable')).toBe(false);
  });

  it('is false for empty / null / undefined', () => {
    expect(isRateLimitError('')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe('shouldEngageCooldown', () => {
  it('is true for either throttle signal', () => {
    expect(shouldEngageCooldown("Sign in to confirm you're not a bot")).toBe(true);
    expect(shouldEngageCooldown('HTTP Error 429: Too Many Requests')).toBe(true);
  });

  it('is false for unrelated terminal errors', () => {
    expect(shouldEngageCooldown('ERROR: This video is private')).toBe(false);
    expect(shouldEngageCooldown('HTTP Error 416')).toBe(false);
    expect(shouldEngageCooldown(null)).toBe(false);
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
