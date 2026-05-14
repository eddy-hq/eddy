/* eslint-disable no-console */
import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { applyChannelInfoToPerson, ensurePersonForChannel } from '../modules/people';

interface Row {
  channel_id: string;
  channel: string | null;
}

// One-shot backfill for the discovery + share-sheet coverage gap fixed in #50.
// `markDownloaded` now triggers person capture for every imported video, but
// rows already in the table from before the fix have a non-null
// `youtube_channel_id` and no matching `person_outputs.external_id`. This
// script walks them, calls `ensurePersonForChannel` to materialise the row,
// then fires `applyChannelInfoToPerson` to populate bio + photo.
//
// Idempotent: a channel that already has a `person_outputs` row is skipped at
// the SQL layer, and `applyChannelInfoToPerson` itself is a COALESCE update
// (won't wipe existing values). Safe to re-run.
async function run(): Promise<void> {
  // DISTINCT on channel_id — same channel may have many requests across users
  // and videos; we only need one yt-dlp metadata call per channel. The MAX()
  // on `channel` picks a non-null display name when available (older rows can
  // have NULL `channel` if metadata never landed).
  const rows = db.prepare(`
    SELECT r.youtube_channel_id AS channel_id, MAX(r.channel) AS channel
      FROM requests r
      LEFT JOIN person_outputs po
        ON po.output_type = 'youtube' AND po.external_id = r.youtube_channel_id
     WHERE r.youtube_channel_id IS NOT NULL
       AND po.output_id IS NULL
     GROUP BY r.youtube_channel_id
     ORDER BY r.youtube_channel_id
  `).all() as Row[];

  if (rows.length === 0) {
    console.log('Backfill: nothing to do — every request channel already has a person_outputs row');
    return;
  }

  console.log(`Backfill: ${rows.length} channels need a person row + bio/photo`);

  let created = 0;
  let captured = 0;
  let failed = 0;

  for (const row of rows) {
    // `channel` can be null on older rows. Use a placeholder so the row
    // exists; `applyChannelInfoToPerson` only updates bio + photo, so the
    // display name stays at the placeholder until a follow / resolve writes
    // the real name. That's acceptable for backfill — the alternative is a
    // synchronous yt-dlp call here just to learn a name, which doubles the
    // run time without changing user-visible behaviour.
    const channelName = row.channel?.trim() || 'Unknown channel';

    let personId: string;
    try {
      ({ personId } = ensurePersonForChannel(row.channel_id, channelName));
      created++;
    } catch (err) {
      failed++;
      logger.warn({ err, channelId: row.channel_id }, 'Backfill: ensurePersonForChannel failed');
      continue;
    }

    try {
      await applyChannelInfoToPerson(personId, row.channel_id);
      captured++;
      console.log(`  Backfilled ${row.channel_id} (${channelName})`);
    } catch (err) {
      // applyChannelInfoToPerson swallows yt-dlp failures itself, so this
      // catch only fires on truly unexpected errors (DB write, etc.).
      logger.warn({ err, channelId: row.channel_id, personId }, 'Backfill: applyChannelInfoToPerson failed');
    }
  }

  console.log(`Backfill complete: ${created} rows ensured, ${captured} info captures attempted, ${failed} failed`);
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
