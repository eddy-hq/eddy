import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import { updatePlexMetadata } from '../modules/content/plex';

interface Row {
  request_id: string;
  youtube_id: string;
  title: string | null;
  description: string | null;
  file_path: string;
  thumbnail_url: string | null;
}

// One-shot: walks requests that have a file on disk and pushes title, summary,
// and poster to their Plex item. Existing items are already indexed, so the
// 2s poll budget is generous. Re-runnable — Plex PUTs are idempotent and lock
// the fields against future scanner agent overwrites.
async function run(): Promise<void> {
  const rows = db.prepare(`
    SELECT request_id, youtube_id, title, description, file_path, thumbnail_url
    FROM requests
    WHERE file_path IS NOT NULL
      AND youtube_id IS NOT NULL
    ORDER BY downloaded_at
  `).all() as Row[];

  logger.info({ total: rows.length }, 'Plex metadata backfill starting');

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.title) {
      logger.debug({ requestId: row.request_id, youtubeId: row.youtube_id }, 'No title in DB — skipping');
      skipped += 1;
      continue;
    }
    const posterUrl = row.thumbnail_url ?? `https://i.ytimg.com/vi/${row.youtube_id}/maxresdefault.jpg`;
    const result = await updatePlexMetadata(
      {
        filePath: row.file_path,
        title: row.title,
        summary: row.description ?? '',
        posterUrl,
      },
      { waitMs: 2_000 },
    );
    if (result) ok += 1; else failed += 1;
  }

  logger.info({ ok, skipped, failed, total: rows.length }, 'Plex metadata backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
