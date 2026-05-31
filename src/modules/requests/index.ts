import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError, NotFoundError } from '../../errors';
import { config } from '../../config';
import { downloadQueue, redis } from '../../queue';
import { getNotifications } from '../notifications';
import { resolveUserByIdOrName } from '../users';
import { toPublicMediaUrl } from '../media';
// State machine lives in `./state` (pure dispatcher) with production wiring in
// `./state-default` (default ports + `getRequestsState` accessor). The router
// reaches `apply` via the accessor so the registered (or test-injected) state
// is read at call time, not captured at import.
import {
  findActiveDuplicateRequest,
  displayRejectionReason,
} from './state';
import { getRequestsState } from './state-default';
import { buildTierSummaries } from './feed-tiers';
import {
  readWeekSummaryCache,
  applyCachedSummaries,
  regenerateStaleWeekSummaries,
} from './week-summary';

export {
  createRequestsState,
  CANCELLED_REASON,
  displayRejectionReason,
  findActiveDuplicateRequest,
} from './state';
export {
  registerDefaultRequestsState,
  getRequestsState,
} from './state-default';
export type {
  Status,
  TransitionResult,
  ApplyOutcome,
  Event,
  DownloadedFields,
  RestoredFields,
  DeleteJobData,
  CreateFromShareSheetInput,
  CreateFromChannelPollInput,
  CreateFromCandidateInput,
  Ports,
  RequestsState,
} from './state';
export {
  buildTierSummaries,
  sourceToKind,
  ageInDays,
  isoWeekRange,
} from './feed-tiers';
export type {
  FeedKind,
  Tier3Day,
  Tier4Week,
  TierInputRow,
} from './feed-tiers';
export {
  readWeekSummaryCache,
  applyCachedSummaries,
  cachedSummaryForWeek,
  computeStaleWeeks,
  groupTier4Weeks,
  generateWeekSummary,
  guardSummary,
  guardSummaryDetailed,
  redactNames,
  buildWeekSummaryPrompt,
  writeWeekSummary,
  regenerateStaleWeekSummaries,
  WEEK_SUMMARY_PROMPT_VERSION,
} from './week-summary';
export type {
  WeekSummaryItem,
  StaleWeek,
  RegenerateResult,
  RegenerateOptions,
  GuardResult,
  GuardFailureReason,
} from './week-summary';

export const requestsRouter = Router();
export const FEED_LIMIT = 1000;

interface AdminRequestRow {
  request_id: string;
  url: string;
  youtube_id: string | null;
  title: string | null;
  status: string;
  rejection_reason: string | null;
  requested_at: string;
  user_name: string;
}

function pwaFeedUrl(userId: string): string {
  return `http://${config.TAILSCALE_IP}:${config.PORT}/feed?userId=${userId}`;
}

const YOUTUBE_REGEX = /^https?:\/\/((www\.|m\.)?youtube\.com\/(watch\?.*v=|shorts\/|live\/)|youtu\.be\/)[\w-]+/;

// Extract first http(s) URL from share-sheet text (iOS sends "Source: YouTube\nhttps://...")
function extractUrlFromText(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : text.trim();
}

// Follow redirects to resolve short/share URLs (share.google, youtu.be, etc.)
async function resolveUrl(raw: string): Promise<string> {
  const url = extractUrlFromText(raw);
  if (url.match(YOUTUBE_REGEX)) return url;
  try {
    // GET + follow HTTP redirects
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Eddy/1.0)' },
    });
    // If final URL after HTTP redirects is already YouTube, use it
    if (resp.url.match(YOUTUBE_REGEX)) return resp.url;
    // share.google JS-redirects — scan body for YouTube URLs
    const body = await resp.text();
    const m = body.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s"'\\]+|https?:\/\/youtu\.be\/[\w-]+/);
    if (m) return m[0].replace(/\\u0026/g, '&');
    return resp.url;
  } catch {
    return url;
  }
}

function extractYoutubeId(url: string): string | null {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /\/live\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Recent terminal failures for the admin pipeline view: `rejected` (guard
// block / yt-dlp terminal error / user cancel) AND `failed` (watchdog gave up
// after re-enqueue escalation). `failed` was previously surfaced nowhere — it
// is excluded from the active query too — so a stuck download that escalated
// was invisible and un-retryable from the UI. Both are retry-eligible via
// RETRY_SOURCES, so the UI offers a Retry on these rows.
export function readRecentFailuresForAdmin(): AdminRequestRow[] {
  return db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.title, r.status,
           r.rejection_reason, r.requested_at, u.display_name AS user_name
    FROM requests r
    JOIN users u ON r.user_id = u.user_id
    WHERE r.status IN ('rejected', 'failed')
      AND r.requested_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    ORDER BY r.requested_at DESC
    LIMIT 20
  `).all() as AdminRequestRow[];
}

// POST /requests — called by iOS Shortcut
requestsRouter.post('/', async (req: Request, res: Response) => {
  const { url, userId, user: userName } = req.body as { url?: string; userId?: string; user?: string };

  if (!url || typeof url !== 'string') {
    logger.warn({ bodyKeys: Object.keys(req.body ?? {}), contentType: req.headers['content-type'] }, 'POST /requests missing url');
    throw new ValidationError('url is required');
  }

  const resolvedUrl = await resolveUrl(url);
  if (!resolvedUrl.match(YOUTUBE_REGEX)) {
    logger.warn({ raw: url, resolved: resolvedUrl }, 'Rejected URL — not a YouTube URL');
    throw new ValidationError('url must be a YouTube URL');
  }

  // Accept either userId (UUID) or user (display name, case-insensitive) for Shortcut convenience
  const lookupValue = userId ?? userName;
  if (!lookupValue) {
    throw new ValidationError('userId or user is required');
  }
  const user = resolveUserByIdOrName(lookupValue);

  const youtubeId = extractYoutubeId(resolvedUrl);

  // Dedup: if this user already has a still-live request for the same video, return it
  if (youtubeId) {
    const existing = findActiveDuplicateRequest(user.user_id, youtubeId);

    if (existing) {
      logger.info({ requestId: existing.requestId, youtubeId }, 'Returning existing request');
      // Re-send the ready notification in case the user missed it
      if (existing.status === 'ready') {
        const row = db.prepare('SELECT title FROM requests WHERE request_id = ?')
          .get(existing.requestId) as { title: string | null } | undefined;
        void getNotifications().notify(
          {
            kind: 'video_ready',
            requestId: existing.requestId,
            title: row?.title ?? youtubeId ?? '',
          },
          user.user_id,
        );
      }
      return res.status(202).json({
        requestId: existing.requestId,
        status: existing.status,
        message: `Got it${user.role === 'kid' ? `, ${user.display_name}` : ''}. Working on it.`,
        pwaUrl: pwaFeedUrl(user.user_id),
      });
    }
  }

  const requestId = uuidv7();
  const { settled } = getRequestsState().apply({
    kind: 'create_share_sheet',
    requestId,
    input: {
      url: resolvedUrl,
      userId: user.user_id,
      youtubeId,
    },
  });
  await settled;

  logger.info({ requestId, userId: user.user_id, url: resolvedUrl }, 'Request received');

  res.status(202).json({
    requestId,
    status: 'downloading',
    message: `Got it${user.role === 'kid' ? `, ${user.display_name}` : ''}. Working on it.`,
    pwaUrl: pwaFeedUrl(user.user_id),
  });
});

// GET /feed?user=... — timeline feed, day-grouped, anchored by added_at
// Returns: {
//   days: [{ date, label, sections?, cards }]          — Tier 1+2, full rows, full history
//   tier3Days: [{ date, count, provenanceMix, topTitles }]      — age 7–29 days
//   tier4Weeks: [{ rangeStart, rangeEnd, count, topChannels, summary }] — age ≥ 30 days
// }
// `days` is unchanged from before (Saved.tsx depends on the full history); the
// tier fields are additive. Tier grouping lives in ./feed-tiers (issue #140).
requestsRouter.get('/feed', (req: Request, res: Response) => {
  const { userId, user: userName } = req.query as { userId?: string; user?: string };
  const lookupValue = userId ?? userName;
  if (!lookupValue) throw new ValidationError('userId or user query param required');
  const found = resolveUserByIdOrName(lookupValue);

  const rows = db.prepare(`
    SELECT
      request_id, url, youtube_id, youtube_channel_id, title, channel, status, file_state,
      rejection_reason, nginx_url, thumbnail_url, duration_secs, why_text,
      requested_at, added_at, watched_at, saved_at, source
    FROM requests
    WHERE user_id = ?
      AND status NOT IN ('dismissed', 'deleted')
      AND NOT (source = 'channel_subscription' AND status IN ('pending', 'downloading'))
    ORDER BY added_at DESC
    LIMIT ?
  `).all(found.user_id, FEED_LIMIT) as Array<{
    request_id: string; url: string; youtube_id: string | null;
    youtube_channel_id: string | null;
    title: string | null; channel: string | null; status: string; file_state: string;
    rejection_reason: string | null; nginx_url: string | null;
    thumbnail_url: string | null; duration_secs: number | null;
    why_text: string | null;
    requested_at: string; added_at: string; watched_at: string | null;
    saved_at: string | null; source: string;
  }>;

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  for (const row of rows) {
    row.rejection_reason = displayRejectionReason(row.rejection_reason);
    row.nginx_url = toPublicMediaUrl(row.nginx_url);
    row.thumbnail_url = toPublicMediaUrl(row.thumbnail_url);
  }

  const dayMap = new Map<string, typeof rows>();
  // Tier inputs are derived from the same day-slicing rule (added_at, falling
  // back to requested_at), and stay in the query's added_at DESC order so
  // Tier 3 topTitles come out most-recent-first within a day.
  const tierRows = rows.map((row) => ({
    day: (row.added_at ?? row.requested_at).slice(0, 10),
    title: row.title,
    channel: row.channel,
    source: row.source,
  }));
  for (const row of rows) {
    const day = (row.added_at ?? row.requested_at).slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)!.push(row);
  }

  function dayLabel(date: string): string {
    if (date === todayStr) return 'Today';
    if (date === yesterdayStr) return 'Yesterday';
    const d = new Date(date + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  const days = Array.from(dayMap.entries()).map(([date, cards]) => {
    const base = { date, label: dayLabel(date), cards };
    if (date !== todayStr) return base;
    // Today collapses to two stretches (ADR-0009): "You asked" (share-sheet
    // requests) and a unified "Today" stream mixing follow (subscription /
    // back-catalogue) and pick (recommended) cards. Each card carries its own
    // provenance pill client-side from `source`, so the stream needs no
    // per-source header. Order is the feed's added_at DESC (preserved from the
    // outer query) — see the PR note on weighted-desc being deferred.
    return {
      ...base,
      sections: [
        { id: 'requests', label: 'You asked', cards: cards.filter((c) => c.source === 'share_sheet') },
        {
          id: 'today',
          label: 'Today',
          cards: cards.filter((c) => c.source === 'channel_subscription' || c.source === 'recommended'),
        },
      ],
    };
  });

  // Tier 3 (per-day, age 7–29) and Tier 4 (per-week, age ≥ 30) summaries are
  // additive top-level fields. `days` (Tier 1+2 full rows) is unchanged —
  // Saved.tsx flatMaps the whole `days` history to find saved items, so it must
  // not be capped to a week. See issue #140.
  const { tier3Days, tier4Weeks } = buildTierSummaries(tierRows, todayStr);

  // Tier 4 editorial summaries (issue #143) are populated from the cache only —
  // a week serves its stored summary when the cached item_count still matches
  // its current count, otherwise null. The feed path never calls Ollama;
  // regeneration of stale weeks happens out-of-band via the admin trigger.
  const summaryCache = readWeekSummaryCache(found.user_id);
  const tier4WeeksWithSummary = applyCachedSummaries(tier4Weeks, summaryCache);

  res.json({ days, tier3Days, tier4Weeks: tier4WeeksWithSummary });
});

// GET /requests/admin/pipeline — active + recent rejected requests across all users
requestsRouter.get('/admin/pipeline', async (_req: Request, res: Response) => {
  const active = db.prepare(`
    SELECT r.request_id, r.url, r.youtube_id, r.title, r.status,
           r.rejection_reason, r.requested_at, u.display_name AS user_name
    FROM requests r
    JOIN users u ON r.user_id = u.user_id
    WHERE r.status IN ('downloading', 'guard_review', 'parent_review', 'pending', 'approved')
    ORDER BY r.requested_at ASC
  `).all() as AdminRequestRow[];

  const recentFailures = readRecentFailuresForAdmin();

  const activeWithJobState = await Promise.all(
    active.map(async (r) => {
      let jobState: string | null = null;
      let progress: number | null = null;
      try {
        const job = await downloadQueue.getJob(r.request_id);
        jobState = job ? await job.getState() : null;
      } catch { /* Redis unavailable */ }
      if (r.status === 'downloading') {
        try {
          const val = await redis.get(`eddy:progress:${r.request_id}`);
          progress = val !== null ? parseInt(val, 10) : null;
        } catch { /* Redis unavailable */ }
      }
      return { ...r, rejection_reason: displayRejectionReason(r.rejection_reason), jobState, progress };
    })
  );

  for (const r of recentFailures) {
    r.rejection_reason = displayRejectionReason(r.rejection_reason);
  }

  res.json({ active: activeWithJobState, recentFailures });
});

// POST /requests/admin/:id/retry — re-enqueue a stuck (`downloading`) or
// escalated (`failed`) download from the admin pipeline view. Same network
// posture as /admin/pipeline (LAN-only, no signed token). Wraps the `retry`
// transition, which cancels any stale BullMQ job and enqueues a fresh one.
// The PWA admin page calls this rather than /internal/requests/:id/retry so
// the worker/HMAC-and-LAN-ops surface stays separate from PWA-facing routes.
requestsRouter.post('/admin/:id/retry', async (req: Request, res: Response) => {
  const requestId = req.params['id']!;
  const { result, settled } = getRequestsState().apply({ kind: 'retry', requestId });
  await settled;

  if (!result.transitioned) {
    if (result.currentStatus === null) throw new NotFoundError('request');
    throw new ValidationError(`Cannot retry a request in status '${result.currentStatus}'`);
  }

  logger.info({ requestId }, 'Admin retry — request returned to downloading');
  res.json({ ok: true, requestId, message: 'Retry requested' });
});

// POST /requests/admin/week-summaries/regenerate — (re)generate Tier 4 week
// summaries for a user (issue #143). By default only stale weeks (current item
// count differs from the cached count, or no cached row) are regenerated; pass
// `{ "force": true }` to regenerate every Tier 4 week regardless of cache state
// (e.g. after a prompt/model/guard change). This is the out-of-band
// regeneration trigger; the GET /feed path only ever reads the cache. Accepts
// userId (UUID) or user (display name) like the other routes. Runs the Gemma
// call site serially over the selected weeks and returns a count summary.
// Internal/admin use only — same network posture as /admin/pipeline (no signed
// token; LAN-only).
requestsRouter.post('/admin/week-summaries/regenerate', async (req: Request, res: Response) => {
  const { userId, user: userName, force } = req.body as { userId?: string; user?: string; force?: boolean };
  const lookupValue = userId ?? userName;
  if (!lookupValue) throw new ValidationError('userId or user is required');
  const found = resolveUserByIdOrName(lookupValue);

  const result = await regenerateStaleWeekSummaries(found.user_id, { force: force === true });
  res.json(result);
});

// DELETE /requests/:id — hard-delete a request record
requestsRouter.delete('/:id', async (req: Request, res: Response) => {
  const requestId = req.params['id'];

  const row = db.prepare(`SELECT status FROM requests WHERE request_id = ?`).get(requestId) as
    | { status: string } | undefined;
  if (!row) throw new NotFoundError('request');

  // If still active, cancel queue job first
  if (['downloading', 'guard_review', 'parent_review', 'pending', 'approved'].includes(row.status)) {
    try {
      const job = await downloadQueue.getJob(requestId);
      await job?.remove();
    } catch { /* best-effort */ }
    try { await redis.del(`eddy:progress:${requestId}`); } catch { /* best-effort */ }
  }

  db.prepare(`DELETE FROM guard_eval WHERE request_id = ?`).run(requestId);
  db.prepare(`DELETE FROM requests WHERE request_id = ?`).run(requestId);
  logger.info({ requestId }, 'Request deleted');
  res.status(204).end();
});

// GET /requests/:id — polled by PWA to check status
requestsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = db.prepare(
    'SELECT request_id, user_id, url, youtube_id, youtube_channel_id, status, title, channel, rejection_reason, nginx_url, why_text, source, requested_at, watched_at, saved_at FROM requests WHERE request_id = ?'
  ).get(req.params['id']) as
    | {
        request_id: string; user_id: string; url: string;
        youtube_id: string | null;
        youtube_channel_id: string | null;
        status: string; title: string | null; channel: string | null;
        rejection_reason: string | null; nginx_url: string | null;
        why_text: string | null;
        source: string;
        requested_at: string;
        watched_at: string | null;
        saved_at: string | null;
      }
    | undefined;

  if (!row) throw new NotFoundError('request');

  let progress: number | null = null;
  if (row.status === 'downloading') {
    try {
      const val = await redis.get(`eddy:progress:${row.request_id}`);
      progress = val !== null ? parseInt(val, 10) : null;
    } catch {
      // Redis unavailable — omit progress rather than failing the request
    }
  }

  res.json({
    requestId: row.request_id,
    userId: row.user_id,
    videoId: row.youtube_id,
    youtubeChannelId: row.youtube_channel_id,
    status: row.status,
    progress,
    title: row.title,
    channel: row.channel,
    rejectionReason: displayRejectionReason(row.rejection_reason),
    videoUrl: toPublicMediaUrl(row.nginx_url),
    // The original YouTube URL as stored on the request. Distinct from
    // `videoUrl` (the local nginx file URL the player streams from); exposed
    // for the PWA's Web Share tile so the recipient gets the canonical
    // YouTube link rather than a household-only nginx path.
    youtubeWatchUrl: row.url,
    whyText: row.why_text,
    source: row.source,
    requestedAt: row.requested_at,
    watchedAt: row.watched_at,
    savedAt: row.saved_at,
  });
});

// POST /requests/:id/watched — PWA marks video as watched
requestsRouter.post('/:id/watched', (req: Request, res: Response) => {
  getRequestsState().apply({ kind: 'mark_watched', requestId: req.params['id']! });
  res.status(204).end();
});

// POST /requests/:id/save — PWA bookmarks a card
requestsRouter.post('/:id/save', (req: Request, res: Response) => {
  db.prepare(
    `UPDATE requests SET saved_at = ? WHERE request_id = ? AND saved_at IS NULL`
  ).run(new Date().toISOString(), req.params['id']);
  res.status(204).end();
});

// DELETE /requests/:id/save — PWA removes bookmark
requestsRouter.delete('/:id/save', (req: Request, res: Response) => {
  db.prepare(
    `UPDATE requests SET saved_at = NULL WHERE request_id = ?`
  ).run(req.params['id']);
  res.status(204).end();
});

// POST /requests/:id/restore — re-download a recycled video (issue #116).
// Gate is `file_state = 'recycled'` regardless of `status`: the recycler
// preserves status, so the row that needs restoring may be `ready`, `watched`
// or `dismissed`. Anything else (live, gone) is rejected with 400 — `live`
// has nothing to restore, `gone` means YouTube removed the source and a
// re-download can't bring it back. No notification, no signed-token URL:
// restore is an in-PWA action on the standard authenticated path. The
// worker callback fires `mark_restored` to flip file_state back to `live`.
requestsRouter.post('/:id/restore', async (req: Request, res: Response) => {
  const requestId = req.params['id']!;

  const row = db
    .prepare(
      `SELECT youtube_id, url, file_state FROM requests WHERE request_id = ?`,
    )
    .get(requestId) as
      | { youtube_id: string | null; url: string; file_state: string }
      | undefined;
  if (!row) throw new NotFoundError('request');

  if (row.file_state !== 'recycled') {
    return res.status(400).json({
      error: 'INVALID_STATE',
      message: `Cannot restore a request with file_state '${row.file_state}'`,
    });
  }

  // Restore requires youtube_id: the worker keys the file path on it
  // (`${youtubeId}.mp4`) and the completion callback path (`/internal/
  // videos/${youtubeId}/restored`) is keyed on it too. A row that landed
  // recycled without youtube_id (rare edge case — original extractYoutubeId
  // returned null on an unusual URL, but yt-dlp still resolved internally
  // and downloaded) can't round-trip through this path; reject loudly
  // rather than enqueue work that would post to /internal/videos//restored
  // and never match the route.
  if (!row.youtube_id) {
    return res.status(400).json({
      error: 'MISSING_YOUTUBE_ID',
      message: 'Cannot restore a request without a stored youtube_id',
    });
  }

  // Enqueue with mode:'restore' so the worker skips the guard score (the
  // original verdict already approved this video) and posts the completion
  // callback to the /restored endpoint, which preserves status.
  //
  // jobId is `restore-${requestId}`, not the bare requestId, because the
  // original download job ran with `jobId: requestId` and BullMQ retains
  // completed jobs (`removeOnComplete: { count: 100 }`). Re-using the same
  // jobId would silently no-op against the still-present completed job — the
  // endpoint would return 202 but the worker would never run. Using a
  // distinct prefix sidesteps that and matches the `delete-${id}` shape we
  // already use for the deletes queue. Single hyphen, no colon — see
  // CLAUDE.md on the BullMQ custom-job-id colon constraint.
  //
  // The same retain-completed-jobs gotcha applies to repeated restores of the
  // same row (restore → recycle → restore again). We mirror what the retry
  // descriptor does: remove any pre-existing completed/failed job at this
  // jobId before adding the new one, so the second restore actually enqueues
  // instead of returning the prior completed job as a duplicate. Best-effort
  // — a missing job is the common path on a first restore.
  const jobId = `restore-${requestId}`;
  try {
    const existing = await downloadQueue.getJob(jobId);
    if (existing) await existing.remove();
  } catch (err) {
    // Don't block the restore on a flaky remove — if Redis is down, the
    // add() below will surface a clearer failure. Log and continue.
    logger.warn({ err, requestId, jobId }, 'Restore: pre-add cleanup of stale job failed');
  }
  try {
    await downloadQueue.add(
      'download',
      {
        requestId,
        // Guaranteed non-null by the MISSING_YOUTUBE_ID gate above.
        youtubeId: row.youtube_id,
        url: row.url,
        mode: 'restore',
      },
      { jobId },
    );
  } catch (err) {
    logger.warn({ err, requestId }, 'Restore: failed to enqueue download job');
    return res.status(500).json({
      error: 'ENQUEUE_FAILED',
      message: 'Failed to enqueue restore job',
    });
  }

  logger.info({ requestId, jobId }, 'Restore enqueued');
  res.status(202).json({ requestId, jobId });
});

// POST /requests/:id/delete — soft-delete: marks record deleted, removes video file
requestsRouter.post('/:id/delete', (req: Request, res: Response) => {
  const requestId = req.params['id']!;
  const { result } = getRequestsState().apply({ kind: 'mark_soft_deleted', requestId });

  if (!result.transitioned) {
    if (result.currentStatus === null) throw new NotFoundError('request');
    return res
      .status(409)
      .json({ error: 'INVALID_STATE', message: `Cannot delete a request in status '${result.currentStatus}'` });
  }

  logger.info({ requestId }, 'Request soft-deleted');
  res.status(204).end();
});

// POST /requests/:id/cancel — PWA cancels an in-progress download
requestsRouter.post('/:id/cancel', (req: Request, res: Response) => {
  const requestId = req.params['id']!;
  const { result } = getRequestsState().apply({ kind: 'mark_cancelled', requestId });

  if (!result.transitioned) {
    if (result.currentStatus === null) throw new NotFoundError('request');
    return res
      .status(409)
      .json({ error: 'INVALID_STATE', message: `Cannot cancel a request in status '${result.currentStatus}'` });
  }

  logger.info({ requestId }, 'Request cancelled');
  res.status(204).end();
});

// GET /requests?userId=... or ?user=... — list requests for a user
requestsRouter.get('/', (req: Request, res: Response) => {
  const { userId, user: userName } = req.query as { userId?: string; user?: string };
  const lookupValue = userId ?? userName;
  if (!lookupValue) throw new ValidationError('userId or user query param required');
  const resolvedUserId = resolveUserByIdOrName(lookupValue).user_id;

  const rows = db.prepare(`
    SELECT request_id, url, youtube_id, title, channel, status, rejection_reason, nginx_url, requested_at
    FROM requests
    WHERE user_id = ?
      AND status NOT IN ('watched', 'dismissed')
    ORDER BY requested_at DESC
    LIMIT 50
  `).all(resolvedUserId) as Array<{
    request_id: string; url: string; youtube_id: string | null;
    title: string | null; channel: string | null; status: string;
    rejection_reason: string | null; nginx_url: string | null; requested_at: string;
  }>;

  for (const row of rows) {
    row.rejection_reason = displayRejectionReason(row.rejection_reason);
    row.nginx_url = toPublicMediaUrl(row.nginx_url);
  }

  res.json({ requests: rows });
});
