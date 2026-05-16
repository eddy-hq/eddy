import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3737),
  DATABASE_PATH: z.string().default('./eddy.db'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_GUARD_MODEL: z.string().default('gemma4:e4b'),
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
  // yt-dlp binary paths — separate vars because the Ubuntu worker (auth/PO-token
  // download path) and the M4 (anonymous metadata calls) install yt-dlp in
  // different locations.
  YTDLP_BIN: z.string().default('yt-dlp'),
  YTDLP_BIN_M4: z.string().default('/opt/homebrew/bin/yt-dlp'),
  // Thumbnails — generated post-download, served by nginx alongside videos
  THUMB_OUTPUT_PATH: z.string().default('/mnt/ssd/eddy/thumbs'),
  NGINX_THUMB_BASE_URL: z.string().optional(),
  // Internal M4 ↔ Ubuntu worker callback
  INTERNAL_HMAC_SECRET: z.string().min(32, 'INTERNAL_HMAC_SECRET must be at least 32 characters'),
  M4_INTERNAL_URL: z.string().optional(), // set on Ubuntu worker; not required on M4
  // Plex — optional until Phase 1
  PLEX_URL: z.string().optional(),
  PLEX_TOKEN: z.string().optional(),
  PLEX_LIBRARY_SECTION_ID: z.string().optional(),
  // SSH access from M4 to the mediaserver (for ops-only scripts that need to
  // read files on the worker box from the M4 — e.g. the file-size backfill
  // for #114). Matches the convention the shell scripts already use under
  // VIDEO_SSH_* (see scripts/watchdog.sh, deploy.sh, healthcheck.sh).
  // Optional so non-ops boots (server, tests) don't require them; the
  // backfill script validates presence at run time and aborts with a clear
  // error message if missing — that's safer than embedding a default host
  // that could send a script at the wrong machine.
  VIDEO_SSH_USER: z.string().optional(),
  VIDEO_SSH_HOST: z.string().optional(),
  VIDEO_SSH_KEY: z.string().optional(),
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

export const config = { ...env, ntfyUserConfig };
