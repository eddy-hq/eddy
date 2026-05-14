import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { ensurePersonForChannel, applyChannelInfoToPerson } from '../modules/people';

interface ChannelRow {
  youtube_channel_id: string;
  channel: string | null;
}

// One-shot backfill for the discovery/share-sheet gap (issue #50). Walks
// `requests` rows with a non-null `youtube_channel_id` that have no matching
// `person_outputs.external_id`, then creates the person row and fires
// applyChannelInfoToPerson once per distinct channel. Idempotent — once a
// person row exists for a channel it falls out of the query, so re-running
// the script is a safe no-op.
async function run(): Promise<void> {
  // Group by channel so we hit yt-dlp once per distinct channel rather than
  // once per request row. Pull the request's `channel` column as a display-name
  // seed for the people row; applyChannelInfoToPerson will overwrite bio/photo
  // afterwards.
  const rows = db.prepare(`
    SELECT youtube_channel_id, MIN(channel) AS channel
    FROM requests
    WHERE youtube_channel_id IS NOT NULL
      AND youtube_channel_id NOT IN (
        SELECT external_id FROM person_outputs
        WHERE output_type = 'youtube' AND external_id IS NOT NULL
      )
    GROUP BY youtube_channel_id
  `).all() as ChannelRow[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — every request channel already has a person row');
    return;
  }

  logger.info({ count: rows.length }, 'Backfill: starting request → person backfill');

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const channelName = row.channel?.trim() || row.youtube_channel_id;
    try {
      const { personId } = ensurePersonForChannel(row.youtube_channel_id, channelName);
      await applyChannelInfoToPerson(personId, row.youtube_channel_id);
      ok++;
      logger.info({ personId, channelId: row.youtube_channel_id }, 'Backfilled request channel');
    } catch (err) {
      failed++;
      logger.warn({ err, channelId: row.youtube_channel_id }, 'Backfill skip');
    }
  }

  logger.info({ ok, failed, total: rows.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
