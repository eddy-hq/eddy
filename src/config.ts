import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3737),
  DATABASE_PATH: z.string().default('./eddy.db'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_GUARD_MODEL: z.string().default('gemma4:e4b'),
  // Optional model override for the Tier 4 week-summary call site (issue #143).
  // Unset reuses the guard model — the summary is a short prose line, not a
  // safety datum, so it shares the guard model by default rather than pulling a
  // second model into memory.
  OLLAMA_SUMMARY_MODEL: z.string().optional(),
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET must be at least 32 characters'),
  TAILSCALE_HOSTNAME: z.string().default('localhost'),
  TAILSCALE_IP: z.string().default('127.0.0.1'),
  BACKUP_SSH_USER: z.string(),
  BACKUP_SSH_HOST: z.string(),
  BACKUP_DEST_PATH: z.string(),
  // Users
  USER_NAME_STEVE: z.string().default('Steve'),
  USER_NAME_BOY1: z.string().default('Boy 1'),
  USER_NAME_BOY2: z.string().default('Boy 2'),
  USER_NAME_PARTNER: z.string().default('Partner'),
  USER_ID_STEVE: z.string().uuid(),
  USER_ID_BOY1: z.string().uuid(),
  USER_ID_BOY2: z.string().uuid(),
  USER_BIRTH_YEAR_BOY1: z.coerce.number().int().optional(),
  USER_BIRTH_YEAR_BOY2: z.coerce.number().int().optional(),
  // ntfy — optional until Phase 1 setup
  NTFY_BASE_URL: z.string().optional(),
  NTFY_TOPIC_STEVE: z.string().optional(),
  NTFY_TOPIC_BOY1: z.string().optional(),
  NTFY_TOPIC_BOY2: z.string().optional(),
  NTFY_CREDS_STEVE: z.string().optional(),
  NTFY_CREDS_BOY1: z.string().optional(),
  NTFY_CREDS_BOY2: z.string().optional(),
  // Video — written locally by the Ubuntu worker
  VIDEO_OUTPUT_PATH: z.string().default('/home/steveu/eddy/videos'),
  NGINX_VIDEO_BASE_URL: z.string().optional(),
  YTDLP_COOKIES_FILE: z.string().optional(), // path to cookies.txt; enables age-restricted downloads
  // Path (ON THE WORKER) to an aged, never-logged-in "guest visitor" cookie jar
  // for the download path. Empty (default) keeps today's behaviour: a fresh
  // anonymous session per yt-dlp invocation. When set to a Netscape cookie jar
  // that exists on the worker, downloads and the resume probe reuse ONE aged
  // guest identity — YouTube appears to score fresh anonymous sessions per IP
  // (yt-dlp #14899/#15865), and an aged never-logged-in jar passes gates a fresh
  // session fails (#15583). NOT an account cookie: no login, nothing to ban; if
  // the identity is flagged, delete the file and mint a new one. A missing file
  // disables the feature for that run — it must never fail a download.
  YTDLP_GUEST_COOKIES: z.string().default(''),
  // yt-dlp binary paths — separate vars because the Ubuntu worker (auth/PO-token
  // download path) and the M4 (anonymous metadata calls) install yt-dlp in
  // different locations.
  YTDLP_BIN: z.string().default('yt-dlp'),
  YTDLP_BIN_M4: z.string().default('/opt/homebrew/bin/yt-dlp'),
  // IP stack every yt-dlp invocation is pinned to (probes and downloads alike).
  // YouTube's bot-detection blocks are per-IP-stack and IPv6 reputation is
  // per-/64, so an unpinned mix lets one stack's block hide behind the other or
  // spread across both. 'ipv4' keeps the fleet in one known reputation bucket;
  // 'ipv6' / 'auto' exist for diagnosis. Maps to argv in ytdlp-ipstack.
  YTDLP_IP_STACK: z.enum(['ipv4', 'ipv6', 'auto']).default('ipv4'),
  // Thumbnails — generated post-download, served by nginx alongside videos
  THUMB_OUTPUT_PATH: z.string().default('/mnt/ssd/eddy/thumbs'),
  NGINX_THUMB_BASE_URL: z.string().optional(),
  // Public (HTTPS) replacements for the two NGINX_*_BASE_URL values above.
  // When set, the API rewrites persisted http://<mediaserver>/... URLs to
  // these on the way out — keeps the PWA same-origin under HTTPS and avoids
  // mixed-content blocking. See toPublicMediaUrl in modules/media.
  PUBLIC_VIDEO_BASE_URL: z.string().optional(),
  PUBLIC_THUMB_BASE_URL: z.string().optional(),
  // Internal M4 ↔ Ubuntu worker callback
  INTERNAL_HMAC_SECRET: z.string().min(32, 'INTERNAL_HMAC_SECRET must be at least 32 characters'),
  M4_INTERNAL_URL: z.string().optional(), // set on Ubuntu worker; not required on M4
  // Plex — optional until Phase 1
  PLEX_URL: z.string().optional(),
  PLEX_TOKEN: z.string().optional(),
  PLEX_LIBRARY_SECTION_ID: z.string().optional(),
  // Storage recycling (issue #115). Per-user soft budget and global hard cap;
  // the recycler runs nightly, freeing video files for users over budget in
  // priority order (dismissed → watched → unwatched-skip-48h; saved never).
  // Defaults: 100 GiB per user, 350 GiB across all users.
  USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(107_374_182_400),
  GLOBAL_STORAGE_CAP_BYTES: z.coerce.number().int().positive().default(375_809_638_400),
  // Discovery intake: filter out interest-search candidates from channels the
  // user has already rejected at or above this count. Counts are derived from
  // candidate_pool.status='dismissed' (pre-play swipe) and requests.status=
  // 'deleted' (player delete), aggregated per channel name. Set to 0 to
  // disable filtering. See issue #147.
  DISCOVERY_CHANNEL_DISMISS_THRESHOLD: z.coerce.number().int().nonnegative().default(3),
  // Discovery slate size (ADR-0009). Role-blind default for the per-user
  // `daily_pick_cap` column: the daily slate is composed into reserved slots
  // up to this ceiling (subscription = cap − 6, back-catalogue 4, delighter
  // 2). The migration backfills existing users to this value; a user whose
  // column is null falls back to this default at compose time.
  DEFAULT_DAILY_PICK_CAP: z.coerce.number().int().positive().default(15),
  // ── yt-dlp throttling (issue #185) ───────────────────────────────────────
  // Cooldown window after a YouTube bot-detection block ("Sign in to confirm
  // you're not a bot"). On the signature error the download worker parks queued
  // jobs in BullMQ's delayed state and discovery skips its searches for this
  // long, rather than retrying straight back into a blocked IP. Shared
  // cross-process via a Redis key (both boxes egress one residential IP).
  // Default 2700s = 45 min. Set 0 to disable the gate entirely.
  YTDLP_BOTDETECT_COOLDOWN_SECS: z.coerce.number().int().nonnegative().default(2700),
  // Discovery interest-search depth (the N in `ytsearchN`). Was hardcoded 20;
  // halved to cut the per-run extraction volume that triggers bot-detection.
  DISCOVERY_SEARCH_LIMIT: z.coerce.number().int().positive().default(10),
  // Base delay + random jitter (ms) inserted between consecutive discovery
  // searches so the per-user fan-out drips instead of bursting. Effective gap
  // is base + random(0, jitter). Set base 0 to disable inter-search spacing.
  DISCOVERY_SEARCH_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  DISCOVERY_SEARCH_JITTER_MS: z.coerce.number().int().nonnegative().default(2000),
  // Per-user discovery hour (local time, 0–23). Each user's daily slate composes
  // at their own hour so the fleet's yt-dlp search + download volume spreads
  // across the day instead of one 06:00 spike from the shared residential IP
  // (#185). Defaults put Steve on the early run and the boys mid-morning /
  // early-afternoon (fresh slate ready before after-school). The channel-wide
  // RSS poll is scheduled at the earliest of these hours, ahead of any user.
  DISCOVERY_HOUR_STEVE: z.coerce.number().int().min(0).max(23).default(6),
  DISCOVERY_HOUR_BOY1: z.coerce.number().int().min(0).max(23).default(14),
  DISCOVERY_HOUR_BOY2: z.coerce.number().int().min(0).max(23).default(10),
  // Fallback hour for any eligible (kid/parent) user not named above. Defensive:
  // the seeded fleet is exactly the three users, but a future row without a
  // configured hour gets discovery here rather than silently none.
  DISCOVERY_HOUR_DEFAULT: z.coerce.number().int().min(0).max(23).default(6),
  // Freshness TTL (days) for the per-person channel-info refresh (bio + avatar).
  // applyChannelInfoToPerson fires once per followed channel on every RSS poll
  // pass; bio/avatar are near-static, so we skip the yt-dlp channel-page fetch
  // unless the last successful refresh is older than this. Deliberately long —
  // this is the dominant volume cut on the people path (#185). 0 disables the
  // gate (refetch every pass, pre-#185 behaviour).
  PERSON_CHANNEL_INFO_TTL_DAYS: z.coerce.number().int().nonnegative().default(30),
  // Global daily download budget (ADR-0012). Caps AUTOMATED downloads — the
  // slate-selected delighters plus follow-sourced subscription / back-catalogue
  // picks — across ALL users for one UTC day. Slate-bound (delighter) downloads
  // are funded first, follow-sourced ones second; once the budget is spent the
  // remaining automated candidates simply wait and stay selectable on a later
  // day (no failure state). Explicit share-sheet / on-demand kid/parent requests
  // count toward the day's tally but are NEVER refused by this gate. Default 10.
  DOWNLOAD_DAILY_BUDGET: z.coerce.number().int().nonnegative().default(10),
  // Back-catalogue moratorium kill-switch (ADR-0012). When false, the daily
  // slate stops mining followed channels' back catalogues (the largest non-slate
  // yt-dlp fan-out); new-upload subscription candidates and interest search are
  // unaffected. Enum-transform rather than z.coerce.boolean() — the latter treats
  // the string "false" as truthy.
  BACK_CATALOGUE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // ── Discovery metadata source (#189) ─────────────────────────────────────
  // Where discovery reads its metadata from. 'ytdlp' (default) scrapes via
  // yt-dlp on the M4; 'api' uses the YouTube Data API v3 (a plain API key,
  // public read-only data, no OAuth) to cut the ~450 hits/day that trip
  // YouTube's IP-wide bot-detection. Downloads stay on yt-dlp either way.
  // See docs/adr (#194).
  DISCOVERY_SOURCE: z.enum(['ytdlp', 'api']).default('ytdlp'),
  // API key for DISCOVERY_SOURCE=api. Required only when that source is
  // selected (enforced by the superRefine below).
  YOUTUBE_API_KEY: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.DISCOVERY_SOURCE === 'api' && !env.YOUTUBE_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['YOUTUBE_API_KEY'],
      message: 'YOUTUBE_API_KEY is required when DISCOVERY_SOURCE=api',
    });
  }
});

const result = schema.safeParse(process.env);

if (!result.success) {
  // console.error is intentional here — logger not yet initialised at config parse time
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

// Derived ntfy user config — flattens the per-user NTFY_TOPIC_* / NTFY_CREDS_*
// env vars into a single array consumed by the notifications module. A user is
// only included if both their topic and credentials are set; missing entries
// fall through to the "ntfy not configured for recipient" warning at send time.
const env = result.data;
const ntfyUserConfig: ReadonlyArray<{ userId: string; topic: string; credentials: string }> = [
  { userId: env.USER_ID_STEVE, topic: env.NTFY_TOPIC_STEVE, credentials: env.NTFY_CREDS_STEVE },
  { userId: env.USER_ID_BOY1,  topic: env.NTFY_TOPIC_BOY1,  credentials: env.NTFY_CREDS_BOY1  },
  { userId: env.USER_ID_BOY2,  topic: env.NTFY_TOPIC_BOY2,  credentials: env.NTFY_CREDS_BOY2  },
].flatMap((entry) =>
  entry.topic && entry.credentials
    ? [{ userId: entry.userId, topic: entry.topic, credentials: entry.credentials }]
    : [],
);

// Per-user discovery hours (#185), flattened for the scheduler. Only the named
// users carry overrides; any other eligible user falls back to
// DISCOVERY_HOUR_DEFAULT inside buildDiscoverySchedule. Keyed by the same fixed
// UUIDs as ntfyUserConfig.
const discoverySchedule: ReadonlyArray<{ userId: string; hour: number }> = [
  { userId: env.USER_ID_STEVE, hour: env.DISCOVERY_HOUR_STEVE },
  { userId: env.USER_ID_BOY1,  hour: env.DISCOVERY_HOUR_BOY1  },
  { userId: env.USER_ID_BOY2,  hour: env.DISCOVERY_HOUR_BOY2  },
];

export const config = { ...env, ntfyUserConfig, discoverySchedule };
