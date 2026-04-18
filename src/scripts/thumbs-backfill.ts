import 'dotenv/config';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { generateThumbnail } from '../workers/thumb';

function signBody(body: string): string {
  return `sha256=${crypto
    .createHmac('sha256', config.INTERNAL_HMAC_SECRET)
    .update(body)
    .digest('hex')}`;
}

async function run(): Promise<void> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    logger.error('M4_INTERNAL_URL is not set — cannot reach the database');
    process.exit(1);
  }

  // Fetch pending rows from M4
  const listResp = await fetch(`${baseUrl}/internal/backfill/pending-thumbs`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!listResp.ok) {
    logger.error({ status: listResp.status }, 'Failed to fetch pending thumbnails from M4');
    process.exit(1);
  }

  const { pending } = await listResp.json() as {
    pending: Array<{ youtube_id: string; file_path: string; duration_secs: number }>;
  };

  logger.info({ count: pending.length }, 'Starting thumbnail backfill');

  let ok = 0;
  let failed = 0;

  for (const row of pending) {
    const thumbUrl = await generateThumbnail(row.youtube_id, row.file_path, row.duration_secs);

    if (!thumbUrl) {
      failed++;
      logger.warn({ youtubeId: row.youtube_id }, 'Thumbnail generation failed — skipping');
      continue;
    }

    const body = JSON.stringify({ thumbnailUrl: thumbUrl });
    const writeResp = await fetch(`${baseUrl}/internal/backfill/thumb/${row.youtube_id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Eddy-Signature': signBody(body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!writeResp.ok) {
      failed++;
      logger.warn({ youtubeId: row.youtube_id, status: writeResp.status }, 'Failed to write thumbnail URL to M4');
      continue;
    }

    ok++;
    logger.info({ youtubeId: row.youtube_id, thumbUrl }, 'Thumbnail backfilled');
  }

  logger.info({ ok, failed, total: pending.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
