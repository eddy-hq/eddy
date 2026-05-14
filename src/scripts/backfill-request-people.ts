/* eslint-disable no-console */
import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { applyChannelInfoToPerson, ensurePersonForChannel } from '../modules/people';

interface ChannelRow {
  channel_id: string;
  channel_name: string;
}

// One-shot fix-up for the gap closed by issue #50: prior to the new trigger
// in the worker-downloaded callback, requests that arrived via discovery and
// the share sheet never produced a `people` row, because none of the three
// pre-fix call sites (follow, resolve, RSS poll) had been touched for those
// videos. This script walks every channel that has at least one request but
// no matching person_outputs row, creates the row pair, and fires the
// channel-info capture so bio + photo land. Idempotent — re-running after a
// successful pass becomes a no-op once the rows exist.
//
// Run on the M4 (yt-dlp + DB live there):
//   npm run people:backfill-requests
async function run(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.youtube_channel_id AS channel_id,
              COALESCE(r.channel, r.youtube_channel_id) AS channel_name
         FROM requests r
         LEFT JOIN person_outputs po
                ON po.output_type = 'youtube'
               AND po.external_id = r.youtube_channel_id
        WHERE r.youtube_channel_id IS NOT NULL
          AND po.output_id IS NULL
        ORDER BY r.youtube_channel_id`,
    )
    .all() as ChannelRow[];

  if (rows.length === 0) {
    console.log('Backfill: nothing to do — every request channel already has a person row');
    return;
  }

  console.log(`Backfill: ${rows.length} channel(s) need a person row`);

  let created = 0;
  let captured = 0;
  let failed = 0;

  for (const row of rows) {
    let personId: string;
    try {
      const result = ensurePersonForChannel(row.channel_id, row.channel_name);
      personId = result.personId;
      created++;
    } catch (err) {
      failed++;
      logger.warn({ err, channelId: row.channel_id }, 'Backfill: ensurePersonForChannel failed');
      continue;
    }

    try {
      await applyChannelInfoToPerson(personId, row.channel_id);
      captured++;
      console.log(`  ok  channel=${row.channel_id} person=${personId}`);
    } catch (err) {
      // applyChannelInfoToPerson swallows yt-dlp failures internally, but be
      // defensive — a thrown error here must not abort the rest of the run.
      logger.warn({ err, channelId: row.channel_id, personId }, 'Backfill: applyChannelInfoToPerson threw');
      console.log(`  warn channel=${row.channel_id} person=${personId} (capture failed, row exists)`);
    }
  }

  console.log(`Backfill complete: created=${created} captured=${captured} failed=${failed} total=${rows.length}`);
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill request-people script failed');
  process.exit(1);
});
