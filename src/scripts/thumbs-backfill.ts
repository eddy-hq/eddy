import 'dotenv/config';
import { config } from '../config';
import { logger } from '../logger';
import { generateThumbnail } from '../workers/thumb';
import { thumbsQueue, redis } from '../queue';
import { postSigned } from '../signed-channel';

async function run(): Promise<void> {
  const force = process.argv.includes('--force');
  const enqueue = process.argv.includes('--enqueue');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : undefined;
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    logger.error('M4_INTERNAL_URL is not set — cannot reach the database');
    process.exit(1);
  }

  const url = force
    ? `${baseUrl}/internal/backfill/pending-thumbs?force=1`
    : `${baseUrl}/internal/backfill/pending-thumbs`;

  const listResp = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!listResp.ok) {
    logger.error({ status: listResp.status }, 'Failed to fetch pending thumbnails from M4');
    process.exit(1);
  }

  const { pending: all } = await listResp.json() as {
    pending: Array<{ youtube_id: string; file_path: string; duration_secs: number }>;
  };
  const pending = typeof limit === 'number' && limit > 0 ? all.slice(0, limit) : all;

  logger.info({ count: pending.length, total: all.length, force, enqueue, limit }, 'Starting thumbnail backfill');

  if (enqueue) {
    await enqueueAll(pending);
    return;
  }

  let ok = 0;
  let failed = 0;

  for (const row of pending) {
    // Always a checked image or the neutral placeholder.
    const thumbUrl = await generateThumbnail(row.youtube_id, row.file_path, row.duration_secs, { force });

    try {
      await postSigned(`/internal/backfill/thumb/${row.youtube_id}`, { thumbnailUrl: thumbUrl }, { timeoutMs: 10_000 });
    } catch (err) {
      failed++;
      logger.warn({ youtubeId: row.youtube_id, err }, 'Failed to write thumbnail URL to M4');
      continue;
    }

    ok++;
    logger.info({ youtubeId: row.youtube_id, thumbUrl }, 'Thumbnail backfilled');
  }

  logger.info({ ok, failed, total: pending.length }, 'Backfill complete');
}

async function enqueueAll(
  pending: Array<{ youtube_id: string; file_path: string; duration_secs: number }>,
): Promise<void> {
  let queued = 0;
  for (const row of pending) {
    await thumbsQueue.add('upgrade', {
      requestId: `backfill:${row.youtube_id}`,
      youtubeId: row.youtube_id,
      filePath: row.file_path,
      durationSecs: row.duration_secs,
    }, { jobId: `thumb:backfill:${row.youtube_id}` });
    queued++;
  }
  logger.info({ queued }, 'Enqueued thumbnail jobs — thumbs worker will process them at concurrency 1');
  await thumbsQueue.close();
  await redis.quit();
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
