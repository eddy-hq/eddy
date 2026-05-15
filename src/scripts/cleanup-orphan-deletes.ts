// One-off cleanup: re-enqueue delete jobs for orphan files left behind by the
// jobId-colon bug (rows marked status='deleted'/file_state='gone' but the
// .mp4 + sidecars still on disk because the enqueue threw before reaching
// BullMQ). Safe to re-run — the worker's processDeleteJob is idempotent
// (ENOENT counts as success).
import { db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { deleteQueue, redis } from '../queue';
import { logger } from '../logger';

async function run(): Promise<void> {
  runMigrations();

  const rows = db.prepare(`
    SELECT request_id, file_path
    FROM requests
    WHERE status = 'deleted' AND file_path IS NOT NULL
    ORDER BY deleted_at
  `).all() as Array<{ request_id: string; file_path: string }>;

  if (rows.length === 0) {
    logger.info('No orphan delete rows to clean up');
    return;
  }

  logger.info({ count: rows.length }, 'Enqueuing orphan delete jobs');

  let enqueued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deleteQueue.add(
        'delete',
        { requestId: row.request_id, filePath: row.file_path },
        { jobId: `delete-cleanup-${row.request_id}` },
      );
      enqueued += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, requestId: row.request_id }, 'Failed to enqueue cleanup delete');
    }
  }

  logger.info({ enqueued, failed }, 'Cleanup enqueue complete');
  await deleteQueue.close();
  await redis.quit();
}

void run().catch((err: unknown) => {
  logger.error({ err }, 'Cleanup script failed');
  process.exit(1);
});
