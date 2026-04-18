import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { generateThumbnail } from '../workers/thumb';

async function run(): Promise<void> {
  const rows = db.prepare(`
    SELECT youtube_id, file_path, duration_secs
    FROM requests
    WHERE file_state = 'live'
      AND status IN ('ready', 'watched')
      AND thumbnail_url IS NULL
      AND file_path IS NOT NULL
      AND youtube_id IS NOT NULL
      AND duration_secs IS NOT NULL
  `).all() as Array<{ youtube_id: string; file_path: string; duration_secs: number }>;

  logger.info({ count: rows.length }, 'Starting thumbnail backfill');

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    const thumbUrl = await generateThumbnail(row.youtube_id, row.file_path, row.duration_secs);
    if (thumbUrl) {
      db.prepare(`UPDATE requests SET thumbnail_url = ? WHERE youtube_id = ? AND thumbnail_url IS NULL`)
        .run(thumbUrl, row.youtube_id);
      ok++;
      logger.info({ youtubeId: row.youtube_id }, 'Thumbnail backfilled');
    } else {
      failed++;
      logger.warn({ youtubeId: row.youtube_id }, 'Thumbnail backfill skipped — no URL generated');
    }
  }

  logger.info({ ok, failed, total: rows.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
