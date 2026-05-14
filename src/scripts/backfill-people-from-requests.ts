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
      AND r.youtube_channel_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM person_outputs po
        WHERE po.output_type = 'youtube'
          AND po.external_id = r.youtube_channel_id
      )
    ORDER BY r.youtube_channel_id
  `).all() as ChannelRow[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — all request channels already have a people row');
    return;
  }

  logger.info({ count: rows.length }, 'Backfill: starting people backfill from requests');

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const channelId = row.youtube_channel_id;
    const channelName = row.channel ?? channelId;
    try {
      const { personId } = ensurePersonForChannel(channelId, channelName);
      await applyChannelInfoToPerson(personId, channelId);
      succeeded++;
      logger.info({ channelId, personId }, 'Backfilled person for channel');
    } catch (err) {
      failed++;
      logger.warn({ err, channelId }, 'Backfill: failed for channel');
    }
  }

  logger.info({ total: rows.length, succeeded, failed }, 'Backfill complete');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
