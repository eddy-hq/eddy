import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { ensurePersonForChannel, applyChannelInfoToPerson } from '../modules/people';

interface ChannelRow {
  youtube_channel_id: string;
  channel: string;
}

async function run(): Promise<void> {
  const rows = db.prepare(`
    SELECT DISTINCT r.youtube_channel_id, r.channel
    FROM requests r
    WHERE r.youtube_channel_id IS NOT NULL
      AND r.youtube_channel_id NOT IN (
        SELECT external_id FROM person_outputs WHERE output_type = 'youtube'
      )
    ORDER BY r.youtube_channel_id
  `).all() as ChannelRow[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — all request channels already have a people row');
    return;
  }

  logger.info({ count: rows.length }, 'Backfill: starting people-from-requests backfill');

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const { personId } = ensurePersonForChannel(row.youtube_channel_id, row.channel);
      await applyChannelInfoToPerson(personId, row.youtube_channel_id);
      ok++;
      logger.info({ personId, channelId: row.youtube_channel_id }, 'Backfilled person');
    } catch (err) {
      failed++;
      logger.warn({ err, channelId: row.youtube_channel_id }, 'Backfill failed for channel');
    }
  }

  logger.info({ ok, failed, total: rows.length }, 'Backfill complete');

  if (failed > 0) process.exit(1);
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
