import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
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
  // ntfy — optional until Phase 1 setup
  NTFY_BASE_URL: z.string().optional(),
  NTFY_TOPIC_STEVE: z.string().optional(),
  NTFY_TOPIC_SON1: z.string().optional(),
  NTFY_TOPIC_SON2: z.string().optional(),
  NTFY_CREDS_STEVE: z.string().optional(),
  NTFY_CREDS_SON1: z.string().optional(),
  NTFY_CREDS_SON2: z.string().optional(),
  // Video / nginx — optional until Phase 1
  VIDEO_OUTPUT_PATH: z.string().optional(),
  NGINX_VIDEO_BASE_URL: z.string().optional(),
  // Plex — optional until Phase 1
  PLEX_URL: z.string().optional(),
  PLEX_TOKEN: z.string().optional(),
  PLEX_LIBRARY_SECTION_ID: z.string().optional(),
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

export const config = result.data;
