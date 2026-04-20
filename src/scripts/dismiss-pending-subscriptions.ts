// One-off cleanup: dismiss pending channel_subscription requests created before
// the first-poll cap was introduced. Removes BullMQ jobs and DB rows.
import { db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { downloadQueue } from '../queue';
import { logger } from '../logger';

async function run(): Promise<void> {
  runMigrations();

  const rows = db.prepare(`
    SELECT request_id, channel, youtube_id
    FROM requests
    WHERE source = 'channel_subscription' AND status = 'pending'
    ORDER BY channel, added_at
  `).all() as Array<{ request_id: string; channel: string; youtube_id: string }>;

  if (rows.length === 0) {
    logger.info('No pending channel subscription requests to clean up');
    return;
  }

  logger.info({ count: rows.length }, 'Removing pending channel subscription requests');

  for (const row of rows) {
    try {
      await downloadQueue.remove(row.request_id);
    } catch {
      // Job may already be processed or not exist — safe to ignore
    }
  }

  const ids = rows.map((r) => r.request_id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM guard_eval WHERE request_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM requests WHERE request_id IN (${placeholders})`).run(...ids);

  const byChannel = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.channel] = (acc[r.channel] ?? 0) + 1;
    return acc;
  }, {});

  logger.info({ removed: rows.length, byChannel }, 'Cleanup complete');
  await downloadQueue.close();
}

void run();
