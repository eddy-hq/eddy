// One-off cleanup: dismiss pending channel_subscription requests created before
// the first-poll cap was introduced. Removes BullMQ jobs and DB rows. Rows a
// parent has decided on or that are drawn as a spot check are kept as labels.
import { db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { downloadQueue } from '../queue';
import { logger } from '../logger';
import { notDecidedOrDrawnSql } from '../modules/decision-subjects';

async function run(): Promise<void> {
  runMigrations();

  const rows = db.prepare(`
    SELECT request_id, channel, youtube_id
    FROM requests
    WHERE source = 'channel_subscription' AND status = 'pending'
      AND ${notDecidedOrDrawnSql('request', 'requests.request_id')}
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

  // Re-check inside the delete's transaction: a request can be decided or
  // drawn as a spot check while the queue jobs are being removed.
  const ids = rows.map((r) => r.request_id);
  const placeholders = ids.map(() => '?').join(',');
  const removedIds = db.transaction(() => {
    const deletable = (db.prepare(`
      SELECT request_id FROM requests
      WHERE request_id IN (${placeholders})
        AND ${notDecidedOrDrawnSql('request', 'requests.request_id')}
    `).all(...ids) as Array<{ request_id: string }>).map((r) => r.request_id);
    if (deletable.length === 0) return deletable;
    const marks = deletable.map(() => '?').join(',');
    db.prepare(`DELETE FROM guard_eval WHERE request_id IN (${marks})`).run(...deletable);
    db.prepare(`DELETE FROM requests WHERE request_id IN (${marks})`).run(...deletable);
    return deletable;
  }).immediate();

  const removedSet = new Set(removedIds);
  const byChannel = rows.filter((r) => removedSet.has(r.request_id)).reduce<Record<string, number>>((acc, r) => {
    acc[r.channel] = (acc[r.channel] ?? 0) + 1;
    return acc;
  }, {});

  logger.info({ removed: removedIds.length, keptAsLabels: rows.length - removedIds.length, byChannel }, 'Cleanup complete');
  await downloadQueue.close();
}

void run();
