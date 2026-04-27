import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { applyChannelInfoToPerson } from '../modules/people/applyChannelInfo';

interface PersonRow {
  person_id: string;
  channel_id: string;
}

// Idempotent — only picks up rows where bio OR photo_url is still null.
// Already-populated rows are skipped without a yt-dlp call.
async function run(): Promise<void> {
  // person_outputs has no uniqueness on (person_id, output_type, external_id),
  // so DISTINCT keeps us from hitting yt-dlp twice for the same channel.
  const rows = db.prepare(`
    SELECT DISTINCT p.person_id, po.external_id AS channel_id
    FROM people p
    INNER JOIN person_outputs po ON po.person_id = p.person_id
    WHERE po.output_type = 'youtube'
      AND po.active = 1
      AND (p.bio IS NULL OR p.photo_url IS NULL)
    ORDER BY p.person_id
  `).all() as PersonRow[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — every person already has bio + photo');
    return;
  }

  logger.info({ count: rows.length }, 'Backfill: starting people bio/photo backfill');

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await applyChannelInfoToPerson(row.person_id, row.channel_id);
      ok++;
      logger.info({ personId: row.person_id, channelId: row.channel_id }, 'Backfilled person');
    } catch (err) {
      failed++;
      logger.warn({ err, channelId: row.channel_id }, 'Backfill skip');
    }
  }

  logger.info({ ok, failed, total: rows.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
