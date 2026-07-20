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
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export const BOT_DETECTION_COOLDOWN_KEY = 'eddy:ytdlp:botdetect-cooldown';

// Escalation level (#185 follow-on). A strike counter that survives the cooldown
// window so consecutive blocks back off progressively harder instead of
// re-trying into a deepening IP block every 45 min. INCR'd on each arm, decayed
// by its own TTL, and reset to nothing by a clean extraction (clearEscalation).
export const BOT_DETECTION_LEVEL_KEY = 'eddy:ytdlp:botdetect-level';

// Multipliers of the base cooldown, indexed by (level - 1), capped at the last
// rung. With the 2700s (45 min) base: 45 min → 3 h → 12 h. The base anchors the
// whole ladder, so changing YTDLP_BOTDETECT_COOLDOWN_SECS scales every rung.
export const COOLDOWN_LADDER = [1, 4, 16];

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

// YouTube's "you're going too fast" signal. Distinct from the bot-detection
// challenge above: a 429 is a soft rate-limit, not a "prove you're human" wall,
// and yt-dlp surfaces it as "HTTP Error 429: Too Many Requests". It does NOT
// match BOT_DETECTION_RE, so before this it sailed past the cooldown and the
// BullMQ retry hammered straight back into the throttle. Treat it as the same
// stand-down trigger. Narrow on purpose — only 429 / explicit rate-limit text,
// never 416/4xx generally — so an unrelated HTTP error can't park the queue.
const RATE_LIMIT_RE = /HTTP Error 429|Too Many Requests|rate[ -]?limit(?:ed|ing|s)?/i;

export function isRateLimitError(text: string | null | undefined): boolean {
  if (!text) return false;
  return RATE_LIMIT_RE.test(text);
}

// Either signal — a bot-detection challenge or a 429 throttle — should arm the
// IP-wide cooldown (#185). Single predicate so every caller treats both the
// same way and a new throttle signature only needs adding here.
export function shouldEngageCooldown(text: string | null | undefined): boolean {
  return isBotDetectionError(text) || isRateLimitError(text);
}

// Arm the cooldown, escalating its length on consecutive blocks. `baseCooldownSecs`
// is rung 1; each block since the last clean extraction climbs the COOLDOWN_LADDER
// (45 min → 3 h → 12 h with the default base), capped at the top rung. INCR is
// atomic, so two in-flight jobs tripping the block at once bump the level rather
// than racing a read-modify-write — at worst that over-escalates by one rung,
// which errs safely toward backing off. The level key is held twice the cooldown
// so a re-block shortly after the window lifts still counts as consecutive; a
// clean run clears it (clearBotDetectionEscalation). `baseCooldownSecs <= 0`
// disables the gate (config escape hatch). Fail-open.
//
// Returns the escalation `level` (the running consecutive-strike count) so a
// caller can act on the threshold — the circuit breaker trips once this reaches
// a fixed number of consecutive re-trips (see `src/circuit-breaker.ts`). Returns
// 0 when the gate is disabled or Redis is unavailable, so a fail-open path never
// looks like a strike.
export async function engageBotDetectionCooldown(
  store: CooldownStore,
  baseCooldownSecs: number,
  reason: string,
): Promise<number> {
  if (baseCooldownSecs <= 0) return 0;
  try {
    const level = await store.incr(BOT_DETECTION_LEVEL_KEY);
    const rung = Math.min(level, COOLDOWN_LADDER.length);
    const cooldownSecs = baseCooldownSecs * COOLDOWN_LADDER[rung - 1]!;
    await store.set(BOT_DETECTION_COOLDOWN_KEY, reason, 'EX', cooldownSecs);
    // Remember the strike longer than the cooldown itself, so a block that
    // lands soon after the window lifts is still seen as consecutive and climbs.
    await store.expire(BOT_DETECTION_LEVEL_KEY, cooldownSecs * 2);
    const atTopRung = rung === COOLDOWN_LADDER.length;
    logger.warn(
      { reason, level, rung, cooldownSecs, atTopRung },
      atTopRung
        ? 'yt-dlp bot-detection cooldown at TOP rung — downloads paused for the long window (IP throttled)'
        : 'yt-dlp bot-detection cooldown engaged (escalating)',
    );
    return level;
  } catch (err) {
    logger.debug({ err }, 'Could not engage bot-detection cooldown (Redis unavailable)');
    return 0;
  }
}

// Reset the escalation after a clean extraction proves the IP recovered: drop
// both the active cooldown and the strike counter, so the next block (if any)
// starts again at rung 1 rather than inheriting stale strikes. Called by the
// worker once metadata fetches successfully. Fail-open — a missed reset just
// means the next block escalates one rung sooner, which is harmless.
export async function clearBotDetectionEscalation(store: CooldownStore): Promise<void> {
  try {
    await store.del(BOT_DETECTION_COOLDOWN_KEY, BOT_DETECTION_LEVEL_KEY);
  } catch (err) {
    logger.debug({ err }, 'Could not clear bot-detection escalation (Redis unavailable)');
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
