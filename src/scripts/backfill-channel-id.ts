import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '../db/client';
import { logger } from '../logger';
import { config } from '../config';

const execFileAsync = promisify(execFile);

interface Row {
  request_id: string;
  youtube_id: string;
}

// Anonymous per-video metadata pull. Avoids the authenticated download stack
// (mweb client, PO token) — this is a one-shot ops script and we only need
// channel_id, which is in the public flat metadata.
async function fetchChannelId(youtubeId: string): Promise<string | null> {
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;
  try {
    const { stdout } = await execFileAsync(
      config.YTDLP_BIN_M4,
      [
        url,
        '--print', '%(.{id,channel_id})j',
        '--no-download',
        '--quiet',
        '--no-warnings',
        '--no-playlist',
      ],
      { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 },
    );
    const line = stdout.split('\n').find((l) => l.trim());
    if (!line) return null;
    const item = JSON.parse(line) as Record<string, unknown>;
    const cid = item['channel_id'];
    return typeof cid === 'string' && cid.trim() ? cid : null;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'Backfill: yt-dlp metadata fetch failed');
    return null;
  }
}

async function run(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT request_id, youtube_id
         FROM requests
        WHERE youtube_id IS NOT NULL
          AND youtube_channel_id IS NULL
          AND status IN ('ready', 'watched')
        ORDER BY added_at DESC`,
    )
    .all() as Row[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — every ready/watched request already has youtube_channel_id');
    return;
  }

  logger.info({ count: rows.length }, 'Backfill: starting youtube_channel_id backfill');

  // De-dupe by youtube_id — same video may appear under multiple users.
  const byVideo = new Map<string, string[]>();
  for (const r of rows) {
    const list = byVideo.get(r.youtube_id) ?? [];
    list.push(r.request_id);
    byVideo.set(r.youtube_id, list);
  }

  const update = db.prepare(
    `UPDATE requests SET youtube_channel_id = ? WHERE request_id = ?`,
  );

  let ok = 0;
  let skipped = 0;
  for (const [youtubeId, requestIds] of byVideo) {
    const channelId = await fetchChannelId(youtubeId);
    if (!channelId) {
      skipped++;
      continue;
    }
    for (const requestId of requestIds) {
      update.run(channelId, requestId);
      ok++;
    }
    logger.info({ youtubeId, channelId, count: requestIds.length }, 'Backfilled');
  }

  logger.info({ ok, skipped, totalVideos: byVideo.size, totalRows: rows.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
