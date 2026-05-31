/**
 * Bot-detection detector + cross-process cooldown gate (issue #185).
 *
 * YouTube rate-blocks our shared residential IP under load ("Sign in to confirm
 * you're not a bot"). The Ubuntu download worker and the M4 discovery search hit
 * the same IP, so the cooldown has to be coordinated across two processes — and
 * the one piece of shared state they both already talk to is Redis. A single key
 * with a TTL is the whole gate: `engage` (re)arms it when a block is detected,
 * `botDetectionCooldownMs` reports how long callers should stand down.
 *
 * The detector is pure (string in, boolean out). The cooldown functions are thin,
 * **fail-open** Redis wrappers: a Redis hiccup must never be the thing that wedges
 * a download or a discovery run shut, so every error path reports "no cooldown"
 * rather than throwing — mirroring how the watchdog/requests treat Redis-down.
 */
import { logger } from './logger';

// The minimal slice of the Redis client these functions touch. Narrow on
// purpose so a test can pass an in-memory fake without constructing a full
// ioredis instance; the production ioredis client satisfies it structurally.
export interface CooldownStore {
  set(key: string, value: string, exMode: 'EX', seconds: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

export const BOT_DETECTION_COOLDOWN_KEY = 'eddy:ytdlp:botdetect-cooldown';

// The signature yt-dlp surfaces when YouTube challenges a request as non-human.
// Matches the canonical "Sign in to confirm you're not a bot" plus the nearby
// phrasings YouTube/yt-dlp have used. Deliberately broad: a false positive only
// costs a recoverable cooldown, whereas a false negative lets the hammering that
// caused the block carry on.
const BOT_DETECTION_RE =
  /sign in to confirm|confirm you[’']?re not a bot|not a bot|bot[- ]?detection|please sign in/i;

export function isBotDetectionError(text: string | null | undefined): boolean {
  if (!text) return false;
  return BOT_DETECTION_RE.test(text);
}

// Arm (or re-arm) the cooldown for `cooldownSecs`. Idempotent — a second call
// inside an active window just resets the TTL, which is exactly right when more
// than one in-flight job trips the block at once. `cooldownSecs <= 0` disables
// the gate (config escape hatch). Fail-open.
export async function engageBotDetectionCooldown(
  store: CooldownStore,
  cooldownSecs: number,
  reason: string,
): Promise<void> {
  if (cooldownSecs <= 0) return;
  try {
    await store.set(BOT_DETECTION_COOLDOWN_KEY, reason, 'EX', cooldownSecs);
    logger.warn({ reason, cooldownSecs }, 'yt-dlp bot-detection cooldown engaged');
  } catch (err) {
    logger.debug({ err }, 'Could not engage bot-detection cooldown (Redis unavailable)');
  }
}

// Remaining cooldown in milliseconds, or 0 when none is active. PTTL returns
// -2 (no key) / -1 (no expiry) / >0 (ms left); anything non-positive means
// "go". Fail-open: a Redis error reports 0 so an outage can't stand the gate up.
export async function botDetectionCooldownMs(store: CooldownStore): Promise<number> {
  try {
    const ttl = await store.pttl(BOT_DETECTION_COOLDOWN_KEY);
    return ttl > 0 ? ttl : 0;
  } catch (err) {
    logger.debug({ err }, 'Could not read bot-detection cooldown (Redis unavailable)');
    return 0;
  }
}
