import { Router, Request, Response } from 'express';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { downloadQueue } from '../../queue';
import { verifySignedJson } from '../../signed-channel';
import { getRequestsState, needsDownloadSecondPass } from '../requests';
import { getNotifications, parseRelayPayload } from '../notifications';
import { checkStuckDownloads } from '../watchdog';
import { scoreForRequest, classifyThumbnail, classifyYtImage, enqueueDownloadSecondPass, scoreThumbnailSafety } from '../guard';
import { ollamaGenerate } from '../../ollama';
import { config } from '../../config';

export const internalRouter = Router();

// Internal routes verify HMAC over the exact bytes received. The rawBody buffer is
// captured during express.json({ verify }) parsing in server.ts; verifySignedJson
// reads it back. The signing/verifying protocol itself lives in signed-channel.ts.

interface DownloadedPayload {
  requestId: string;
  youtubeId: string;
  filePath: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
  title: string;
  channel: string;
  youtubeChannelId?: string | null;
  description: string;
  durationSecs: number;
  transcript: string | null;
  // Video's own publish date (ISO 8601) from yt-dlp's `upload_date`. Optional
  // on the wire so an older worker predating #186 still produces a valid
  // mark_downloaded — the column just stays null for those.
  publishedAt?: string | null;
  // Bytes on disk captured by the worker after yt-dlp finishes. Optional on
  // the wire so an older worker that hasn't shipped #114 yet still produces
  // a valid mark_downloaded — the column just stays null until the backfill
  // script catches up.
  fileSizeBytes?: number | null;
}

// POST /internal/videos/:youtube_id/downloaded — called by Ubuntu worker on success.
// A kid's slate pick doesn't go straight to ready: it lands in guard_review
// (hidden) and the download-time second pass (Phase 6a) decides whether it
// becomes visible. The guard runs on the M4's queue, not inside this request,
// so a busy Ollama can't time out the worker's callback and trigger a retry.
internalRouter.post('/videos/:youtube_id/downloaded', verifySignedJson<DownloadedPayload>(async (req, res, payload) => {
  const { requestId, filePath, nginxUrl, thumbnailUrl, title, channel, youtubeChannelId, description, durationSecs, transcript, publishedAt, fileSizeBytes } = payload;

  const secondPass = needsDownloadSecondPass(requestId);
  const { result } = getRequestsState().apply({
    kind: secondPass ? 'mark_downloaded_for_second_pass' : 'mark_downloaded',
    requestId,
    fields: {
      title,
      channel,
      youtubeChannelId: youtubeChannelId ?? null,
      description,
      durationSecs,
      transcript,
      filePath,
      nginxUrl,
      thumbnailUrl,
      publishedAt: publishedAt ?? null,
      fileSizeBytes: fileSizeBytes ?? null,
    },
  });

  if (result.transitioned && secondPass) {
    logger.info({ requestId, youtubeId: req.params['youtube_id'] }, 'Slate pick downloaded — queued for the second pass');
    await enqueueDownloadSecondPass(requestId);
  } else if (result.transitioned) {
    logger.info({ requestId, youtubeId: req.params['youtube_id'] }, 'Request marked ready');
  } else {
    // No-op: row was no longer `downloading` (e.g. user cancelled mid-download).
    // The worker callback raced with a state change; downstream is unaffected.
    logger.info(
      { requestId, youtubeId: req.params['youtube_id'], currentStatus: result.currentStatus },
      'Worker downloaded callback ignored — request not in downloading state',
    );
  }
  res.status(204).end();
}));

// POST /internal/videos/:youtube_id/restored — called by Ubuntu worker on
// successful re-download of a recycled file (issue #116). Sibling of the
// /downloaded callback, but threads through `mark_restored` instead of
// `mark_downloaded` so status is preserved and the user isn't re-notified.
interface RestoredPayload {
  requestId: string;
  youtubeId: string;
  filePath: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
  fileSizeBytes?: number | null;
}
internalRouter.post('/videos/:youtube_id/restored', verifySignedJson<RestoredPayload>((req, res, payload) => {
  const { requestId, filePath, nginxUrl, thumbnailUrl, fileSizeBytes } = payload;

  const { result } = getRequestsState().apply({
    kind: 'mark_restored',
    requestId,
    fields: {
      filePath,
      nginxUrl,
      thumbnailUrl,
      fileSizeBytes: fileSizeBytes ?? null,
    },
  });

  if (result.transitioned) {
    logger.info({ requestId, youtubeId: req.params['youtube_id'] }, 'Request restored from recycle');
  } else {
    // No-op: the row's file_state was no longer 'recycled' (concurrent
    // restore, or the recycler ran again between enqueue and callback).
    logger.info(
      { requestId, youtubeId: req.params['youtube_id'], currentStatus: result.currentStatus },
      'Worker restored callback ignored — request no longer in recycled state',
    );
  }
  res.status(204).end();
}));

// POST /internal/requests/:id/rejected — called by Ubuntu worker on terminal failure
internalRouter.post('/requests/:id/rejected', verifySignedJson<{ requestId: string; reason: string }>((_req, res, payload) => {
  const { result } = getRequestsState().apply({
    kind: 'mark_rejected',
    requestId: payload.requestId,
    reason: payload.reason,
  });

  if (result.transitioned) {
    logger.info({ requestId: payload.requestId, reason: payload.reason }, 'Request rejected by worker');
  } else {
    logger.info(
      { requestId: payload.requestId, reason: payload.reason, currentStatus: result.currentStatus },
      'Worker rejection callback ignored — request not in downloading state',
    );
  }
  res.status(204).end();
}));

// POST /internal/requests/:id/failed — called by the Ubuntu worker when a
// download exhausts its BullMQ retry budget on a non-terminal error (issue
// #183). The worker owns this terminal transition so the request can't orphan
// at `downloading` waiting on the (unreliable, in-memory-counter) watchdog
// escalation. mark_failed gates on `downloading`, so a row that already moved
// on (user-cancelled, or a success callback that raced in) is a safe no-op.
internalRouter.post('/requests/:id/failed', verifySignedJson<{ requestId: string; reason?: string }>((_req, res, payload) => {
  // Read for the alert before the transition — mark_failed doesn't clear these
  // columns, but reading first keeps the notification independent of ordering.
  const row = db.prepare(
    'SELECT title, youtube_id, url, requested_at FROM requests WHERE request_id = ?',
  ).get(payload.requestId) as
    | { title: string | null; youtube_id: string | null; url: string; requested_at: string }
    | undefined;

  const { result } = getRequestsState().apply({
    kind: 'mark_failed',
    requestId: payload.requestId,
  });

  if (result.transitioned) {
    logger.warn(
      { requestId: payload.requestId, reason: payload.reason },
      'Request marked failed by worker (download attempts exhausted)',
    );
    // Preserve the visibility the watchdog used to provide on escalation: now
    // that the worker owns this transition the watchdog never sees the row, so
    // alert Steve here rather than let an exhausted download be a silent dead
    // end. The admin pipeline also surfaces `failed` rows for one-tap retry.
    if (row) {
      void getNotifications().notify(
        {
          kind: 'download_alert',
          requestId: payload.requestId,
          title: row.title ?? row.youtube_id ?? row.url,
          stuckMins: Math.round((Date.now() - new Date(row.requested_at).getTime()) / 60_000),
          action: 'failed',
        },
        config.USER_ID_STEVE,
      );
    }
  } else {
    logger.info(
      { requestId: payload.requestId, currentStatus: result.currentStatus },
      'Worker failed callback ignored — request not in downloading state',
    );
  }
  res.status(204).end();
}));

// POST /internal/requests/:id/file-deleted — called by Ubuntu worker after the
// soft-delete unlink. Surfaces non-ENOENT failures on the M4 (the M4 used to
// run the unlink itself against an Ubuntu-only path; every call returned ENOENT
// and looked like success). DB row is already `deleted` — this is purely
// observability; nothing here writes back to SQLite.
interface FileDeletedPayload {
  requestId: string;
  failures: Array<{ path: string; code: string }>;
}
internalRouter.post('/requests/:id/file-deleted', verifySignedJson<FileDeletedPayload>((_req, res, payload) => {
  if (payload.failures.length > 0) {
    logger.warn({ requestId: payload.requestId, failures: payload.failures }, 'Worker reported file-delete failures');
  } else {
    logger.info({ requestId: payload.requestId }, 'Worker confirmed file delete');
  }
  res.status(204).end();
}));

// GET /internal/health/queue — queue stats + stuck downloads (no auth — internal network only)
internalRouter.get('/health/queue', async (_req: Request, res: Response) => {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const stuck = db.prepare(`
    SELECT request_id, youtube_id, title, user_id, requested_at, status
    FROM requests
    WHERE status = 'downloading'
      AND requested_at < ?
    ORDER BY requested_at ASC
  `).all(cutoff) as Array<{
    request_id: string; youtube_id: string | null; title: string | null;
    user_id: string; requested_at: string; status: string;
  }>;

  const stuckWithJobState = await Promise.all(
    stuck.map(async (r) => {
      let jobState: string | null = null;
      try {
        const job = await downloadQueue.getJob(r.request_id);
        jobState = job ? await job.getState() : null;
      } catch { /* Redis unavailable */ }
      return {
        requestId: r.request_id,
        youtubeId: r.youtube_id,
        title: r.title,
        requestedAt: r.requested_at,
        stuckMins: Math.round((Date.now() - new Date(r.requested_at).getTime()) / 60_000),
        jobState,
      };
    })
  );

  let queueCounts = null;
  try {
    queueCounts = await downloadQueue.getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed');
  } catch { /* Redis unavailable */ }

  res.json({
    stuckCount: stuckWithJobState.filter((r) => r.jobState !== 'active').length,
    downloading: stuckWithJobState,
    queue: queueCounts,
  });
});

// POST /internal/requests/:id/retry — re-enqueue a stuck or failed download
internalRouter.post('/requests/:id/retry', async (req: Request, res: Response) => {
  const requestId = req.params['id']!;
  const { result, settled } = getRequestsState().apply({ kind: 'retry', requestId });
  await settled;

  if (!result.transitioned) {
    if (result.currentStatus === null) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Request not found' });
    }
    return res.status(400).json({ error: 'INVALID_STATE', message: `Cannot retry a request in status '${result.currentStatus}'` });
  }

  // The retry event is best-effort about the BullMQ enqueue — a failed add()
  // is logged-warned, not surfaced. The watchdog will pick up rows that end up
  // `downloading` without a live job. So response wording reflects what's
  // guaranteed (the transition), not the queue side-effect.
  logger.info({ requestId }, 'Manual retry — request returned to downloading');
  res.json({ ok: true, requestId, message: 'Retry requested' });
});

// GET /internal/backfill/pending-thumbs — list videos needing thumbnail generation (no HMAC, internal network only)
// ?force=1 returns all live videos regardless of whether thumbnail_url is already set
internalRouter.get('/backfill/pending-thumbs', (req: Request, res: Response) => {
  const force = req.query['force'] === '1';
  const rows = db.prepare(`
    SELECT youtube_id, file_path, duration_secs, added_at
    FROM requests
    WHERE file_state = 'live'
      AND status IN ('ready', 'watched')
      AND file_path IS NOT NULL
      AND youtube_id IS NOT NULL
      AND duration_secs IS NOT NULL
      ${force ? '' : 'AND thumbnail_url IS NULL'}
    ORDER BY added_at DESC
  `).all() as Array<{ youtube_id: string; file_path: string; duration_secs: number; added_at: string }>;

  res.json({ pending: rows });
});

// POST /internal/backfill/thumb/:youtube_id — write generated thumbnail URL back to DB
internalRouter.post('/backfill/thumb/:youtube_id', verifySignedJson<{ thumbnailUrl: string }>((req, res, payload) => {
  db.prepare(`
    UPDATE requests SET thumbnail_url = @thumbnail_url
    WHERE youtube_id = @youtube_id
  `).run({ thumbnail_url: payload.thumbnailUrl, youtube_id: req.params['youtube_id'] });

  logger.info({ youtubeId: req.params['youtube_id'] }, 'Thumbnail backfilled via worker');
  res.status(204).end();
}));

// POST /internal/thumb/classify — called by Ubuntu worker; fetches YT thumbnail, classifies with Gemma vision
internalRouter.post('/thumb/classify', verifySignedJson<{ youtubeId: string }>(async (_req, res, payload) => {
  const style = await classifyThumbnail(payload.youtubeId);
  res.json({ style });
}));

// POST /internal/thumb/classify-variant — classify an arbitrary YT thumbnail variant (e.g. hq1, hq2, hq3).
// Used by the worker during the editorial-selection chain for auto-generated frame thumbnails.
internalRouter.post('/thumb/classify-variant', verifySignedJson<{ youtubeId: string; variant: string }>(async (_req, res, payload) => {
  if (typeof payload.youtubeId !== 'string' || typeof payload.variant !== 'string') {
    return res.status(400).json({ error: 'youtubeId and variant required' });
  }
  if (!/^(hq|mq|maxres|sd)?(default|[1-3])$/.test(payload.variant)) {
    return res.status(400).json({ error: 'unsupported variant' });
  }

  const style = await classifyYtImage(payload.youtubeId, payload.variant);
  res.json({ style });
}));

// POST /internal/thumb/safety — thumbnail safety floor (brief §6, Phase 6a).
// Body is { image } (base64): the worker sends the exact bytes it would serve.
// Always answers 200 with a verdict; a model or parse failure is a failing
// verdict, never a passing one.
internalRouter.post('/thumb/safety', verifySignedJson<{ image?: unknown }>(async (_req, res, payload) => {
  if (typeof payload.image !== 'string' || payload.image.length === 0) {
    return res.status(400).json({ error: 'image required' });
  }
  const verdict = await scoreThumbnailSafety(payload.image);
  res.json(verdict);
}));

// POST /internal/thumb/score-frame — proxy for Ubuntu worker to score a local frame against Gemma.
// Ollama binds to localhost on M4, so the worker can't hit it directly; this relays.
internalRouter.post('/thumb/score-frame', verifySignedJson<{ image: string; prompt: string }>(async (_req, res, payload) => {
  if (typeof payload.image !== 'string' || typeof payload.prompt !== 'string') {
    return res.status(400).json({ error: 'image and prompt required' });
  }

  try {
    const raw = await ollamaGenerate(payload.prompt, undefined, [payload.image]);
    if (!raw.trim()) {
      logger.warn({ imageBytes: payload.image.length }, 'score-frame Ollama returned empty response');
    }
    res.json({ raw });
  } catch (err) {
    logger.warn({ err }, 'score-frame Ollama call failed');
    res.status(502).json({ error: String(err) });
  }
}));

// POST /internal/watchdog/run — trigger an immediate watchdog check (for testing/ops)
// POST /internal/notify — the worker hands over an ops alert it cannot deliver
// itself (no database, no APNs key). Only the two kinds the worker raises are
// accepted; the M4's own notify() logs and delivers it. The reply goes before
// delivery: an APNs send with its one retry can outlast the worker's 10s relay
// timeout, and notify() never throws, so there is nothing to wait for.
internalRouter.post('/notify', verifySignedJson<unknown>(async (_req, res, payload) => {
  const relayed = parseRelayPayload(payload);
  if (!relayed) {
    res.status(400).json({ error: 'Not a relayable notification' });
    return;
  }
  res.json({ ok: true });
  void getNotifications().notify(relayed.event, relayed.recipient);
}));

internalRouter.post('/watchdog/run', (_req: Request, res: Response) => {
  void checkStuckDownloads().catch((err: unknown) => {
    logger.error({ err }, 'Manual watchdog check failed');
  });
  res.json({ ok: true, message: 'Watchdog check triggered' });
});

interface GuardScorePayload {
  requestId: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  transcript: string | null;
}

// POST /internal/guard/score — called by Ubuntu worker after metadata fetch, before download.
// Shadow mode (Phase 3): always returns proceed:true. Phase 6: flip to return real verdict.
internalRouter.post('/guard/score', verifySignedJson<GuardScorePayload>(async (_req, res, payload) => {
  const row = db.prepare('SELECT user_id FROM requests WHERE request_id = ?')
    .get(payload.requestId) as { user_id: string } | undefined;

  if (!row) {
    return res.status(404).json({ error: 'Request not found' });
  }

  // Write metadata now so the card shows title/channel during download
  db.prepare(`
    UPDATE requests SET title = @title, channel = @channel
    WHERE request_id = @request_id AND title IS NULL
  `).run({ title: payload.title, channel: payload.channel, request_id: payload.requestId });

  // A kid's slate pick is guarded after download instead (the second pass,
  // which enforces). A shadow score here would only duplicate that Gemma call.
  if (needsDownloadSecondPass(payload.requestId)) {
    return res.json({ proceed: true, verdict: 'deferred', reason: 'Guarded after download' });
  }

  let verdict;
  try {
    verdict = await scoreForRequest({ ...payload, userId: row.user_id });
  } catch (err) {
    logger.error({ err, requestId: payload.requestId }, 'Guard score endpoint error');
    // Never block a download in shadow mode
    return res.json({ proceed: true, verdict: 'uncertain', reason: 'Guard error' });
  }

  // Shadow mode: always proceed regardless of verdict
  res.json({ proceed: true, verdict: verdict.verdict, reason: verdict.reason });
}));
