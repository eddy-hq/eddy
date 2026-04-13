import { Worker, Job } from 'bullmq';
import { unlink } from 'fs/promises';
import path from 'path';
import { redis } from '../../queue';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { fetchMetadata, downloadVideo } from './ytdlp';
import { transferToUbuntu } from './transfer';
import { triggerPlexScan } from './plex';

// In-memory progress store — requestId → 0-100. Cleared on completion/failure.
const downloadProgress = new Map<string, number>();

export function getDownloadProgress(requestId: string): number | null {
  return downloadProgress.get(requestId) ?? null;
}

export interface DownloadJobData {
  requestId: string;
  youtubeId: string;
  url: string;
}

function setStatus(requestId: string, status: string, extra: Record<string, unknown> = {}): void {
  const fields = Object.keys(extra).map((k) => `${k} = @${k}`).join(', ');
  const sql = fields
    ? `UPDATE requests SET status = @status, ${fields} WHERE request_id = @request_id`
    : `UPDATE requests SET status = @status WHERE request_id = @request_id`;
  db.prepare(sql).run({ status, request_id: requestId, ...extra });
}

async function processDownload(job: Job<DownloadJobData>): Promise<void> {
  const { requestId, youtubeId, url } = job.data;
  const log = logger.child({ requestId, youtubeId });

  log.info('Processing download job');

  // Phase 1: auto-approve everything (guard is Phase 3)
  setStatus(requestId, 'approved', { decided_by: 'auto', decided_at: new Date().toISOString() });

  // Check if this video is already on Ubuntu from a previous request
  const existing = db.prepare(`
    SELECT file_path, nginx_url FROM requests
    WHERE youtube_id = ? AND status = 'ready' AND file_path IS NOT NULL
    LIMIT 1
  `).get(youtubeId) as { file_path: string; nginx_url: string | null } | undefined;

  if (existing) {
    log.info({ youtubeId }, 'Video already on media server — skipping download');
    setStatus(requestId, 'ready', {
      file_path: existing.file_path,
      nginx_url: existing.nginx_url,
      downloaded_at: new Date().toISOString(),
    });
    return;
  }

  // 1. Fetch metadata
  log.info('Fetching metadata');
  let metadata;
  try {
    metadata = await fetchMetadata(url);
  } catch (err: unknown) {
    const isTerminal = (err as { terminal?: boolean }).terminal === true;
    const reason = err instanceof Error ? err.message : 'Eddy hit a problem — trying again later.';
    log.warn({ err, isTerminal }, 'Metadata fetch failed');
    if (isTerminal) {
      setStatus(requestId, 'rejected', { rejection_reason: reason });
      return; // don't retry
    }
    throw err; // BullMQ will retry
  }

  // Update request with metadata
  db.prepare(`
    UPDATE requests
    SET title = @title, channel = @channel, description = @description,
        duration_secs = @duration_secs, transcript = @transcript
    WHERE request_id = @request_id
  `).run({
    title: metadata.title,
    channel: metadata.channel,
    description: metadata.description,
    duration_secs: metadata.durationSecs,
    transcript: metadata.transcript,
    request_id: requestId,
  });

  // 2. Download video
  setStatus(requestId, 'downloading');
  downloadProgress.set(requestId, 0);
  log.info('Downloading video');

  let localPath: string;
  try {
    localPath = await downloadVideo(youtubeId, url, (pct) => {
      downloadProgress.set(requestId, pct);
    });
  } catch (err: unknown) {
    const isTerminal = (err as { terminal?: boolean }).terminal === true;
    const reason = err instanceof Error ? err.message : 'Eddy hit a problem — trying again later.';
    log.warn({ err, isTerminal }, 'Download failed');
    downloadProgress.delete(requestId);
    if (isTerminal) {
      setStatus(requestId, 'rejected', { rejection_reason: reason });
      return;
    }
    throw err;
  }

  downloadProgress.delete(requestId);

  // 3. Transfer to Ubuntu
  log.info('Transferring to media server');
  let remoteFile: string;
  try {
    remoteFile = await transferToUbuntu(localPath, youtubeId);
  } catch (err) {
    log.error({ err }, 'Transfer failed');
    throw err; // keep temp file so BullMQ retry can rsync without re-downloading
  }

  // 4. Clean up temp file
  await unlink(localPath).catch((err) => log.warn({ err }, 'Could not delete temp file'));

  // 5. Build nginx URL and mark ready
  const nginxBase = config.NGINX_VIDEO_BASE_URL ?? '';
  const nginxUrl = nginxBase
    ? `${nginxBase.replace(/\/$/, '')}/${path.basename(remoteFile)}`
    : null;

  setStatus(requestId, 'ready', {
    file_path: remoteFile,
    nginx_url: nginxUrl,
    downloaded_at: new Date().toISOString(),
  });

  log.info({ nginxUrl }, 'Request ready');

  // 6. Trigger Plex scan (best-effort, non-blocking)
  void triggerPlexScan();
}

export function startDownloadWorker(): Worker<DownloadJobData> {
  const worker = new Worker<DownloadJobData>(
    'downloads',
    processDownload,
    {
      connection: redis,
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, requestId: job.data.requestId }, 'Download job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, requestId: job?.data.requestId, err }, 'Download job failed');
  });

  logger.info('Download worker started');
  return worker;
}
