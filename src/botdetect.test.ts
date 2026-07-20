import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isBotDetectionError,
  isRateLimitError,
  shouldEngageCooldown,
  engageBotDetectionCooldown,
  clearBotDetectionEscalation,
  botDetectionCooldownMs,
  BOT_DETECTION_COOLDOWN_KEY,
  BOT_DETECTION_LEVEL_KEY,
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

// In-memory fake implementing just the slice botdetect uses — a real keyed map
// so the escalation ladder (INCR level + per-key TTLs) is exercised honestly.
// `calls` keeps the historical set-call log the older assertions read.
function fakeStore(): CooldownStore & {
  calls: Array<[string, string, string, number]>;
  data: Map<string, { value: string; ttlMs: number }>;
} {
  const data = new Map<string, { value: string; ttlMs: number }>();
  return {
    calls: [],
    data,
    async set(key, value, exMode, seconds) {
      this.calls.push([key, value, exMode, seconds]);
      data.set(key, { value, ttlMs: seconds * 1000 });
      return 'OK';
    },
    async pttl(key) {
      const e = data.get(key);
      return e ? e.ttlMs : -2;
    },
    async incr(key) {
      const e = data.get(key);
      const n = (e ? parseInt(e.value, 10) || 0 : 0) + 1;
      data.set(key, { value: String(n), ttlMs: e?.ttlMs ?? -1 });
      return n;
    },
    async expire(key, seconds) {
      const e = data.get(key);
      if (e) e.ttlMs = seconds * 1000;
      return 1;
    },
    async del(...keys) {
      let count = 0;
      for (const k of keys) if (data.delete(k)) count++;
      return count;
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
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn(),
      del: vi.fn(),
    };
    // Fail-open reports level 0 so a Redis outage never looks like a strike.
    await expect(engageBotDetectionCooldown(store, 2700, 'search')).resolves.toBe(0);
  });

  it('returns the escalation level so the caller can act on the threshold', async () => {
    const store = fakeStore();
    expect(await engageBotDetectionCooldown(store, 2700, 'metadata')).toBe(1);
    expect(await engageBotDetectionCooldown(store, 2700, 'metadata')).toBe(2);
    expect(await engageBotDetectionCooldown(store, 2700, 'metadata')).toBe(3);
  });

  it('returns 0 when the gate is disabled (secs <= 0)', async () => {
    const store = fakeStore();
    expect(await engageBotDetectionCooldown(store, 0, 'metadata')).toBe(0);
  });
});

describe('engageBotDetectionCooldown — escalation ladder', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('climbs the ladder on consecutive blocks, capped at the top rung', async () => {
    const store = fakeStore();
    await engageBotDetectionCooldown(store, 2700, 'metadata'); // rung 1
    expect(await botDetectionCooldownMs(store)).toBe(2700 * 1000); // 45 min
    await engageBotDetectionCooldown(store, 2700, 'metadata'); // rung 2
    expect(await botDetectionCooldownMs(store)).toBe(2700 * 1000 * 4); // 3 h
    await engageBotDetectionCooldown(store, 2700, 'metadata'); // rung 3
    expect(await botDetectionCooldownMs(store)).toBe(2700 * 1000 * 16); // 12 h
    await engageBotDetectionCooldown(store, 2700, 'metadata'); // beyond — capped
    expect(await botDetectionCooldownMs(store)).toBe(2700 * 1000 * 16);
  });

  it('holds the strike counter for twice the cooldown so a prompt re-block still climbs', async () => {
    const store = fakeStore();
    await engageBotDetectionCooldown(store, 2700, 'metadata');
    expect(store.data.get(BOT_DETECTION_LEVEL_KEY)?.ttlMs).toBe(2700 * 1000 * 2);
  });

  it('resets to rung 1 after a clean run clears the escalation', async () => {
    const store = fakeStore();
    await engageBotDetectionCooldown(store, 2700, 'metadata'); // rung 1
    await engageBotDetectionCooldown(store, 2700, 'metadata'); // rung 2
    expect(await botDetectionCooldownMs(store)).toBe(2700 * 1000 * 4);

    await clearBotDetectionEscalation(store);
    // Clearing drops the active cooldown too — queued jobs can proceed.
    expect(await botDetectionCooldownMs(store)).toBe(0);

    await engageBotDetectionCooldown(store, 2700, 'metadata'); // fresh strike → rung 1
    expect(await botDetectionCooldownMs(store)).toBe(2700 * 1000);
  });

  it('clearBotDetectionEscalation is fail-open on Redis error', async () => {
    const store: CooldownStore = {
      set: vi.fn(), pttl: vi.fn(), incr: vi.fn(), expire: vi.fn(),
      del: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    await expect(clearBotDetectionEscalation(store)).resolves.toBeUndefined();
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
    expect(await botDetectionCooldownMs(store)).toBe(0); // absent → pttl -2
    store.data.set(BOT_DETECTION_COOLDOWN_KEY, { value: 'x', ttlMs: -1 });
    expect(await botDetectionCooldownMs(store)).toBe(0); // present but no expiry
  });

  it('returns 0 on Redis error (fail-open)', async () => {
    const store: CooldownStore = {
      set: vi.fn(),
      pttl: vi.fn().mockRejectedValue(new Error('connection refused')),
      incr: vi.fn(), expire: vi.fn(), del: vi.fn(),
    };
    expect(await botDetectionCooldownMs(store)).toBe(0);
  });
});
