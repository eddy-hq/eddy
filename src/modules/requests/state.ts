import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { sendVideoReady } from '../notifications';
import { downloadQueue, deleteQueue, redis } from '../../queue';
import type { DownloadJobData } from '../content';
import { ensurePersonForChannel, applyChannelInfoToPerson } from '../people';

// Shared job data for the delete queue. The worker uses filePath to unlink the
// .mp4 + sidecars; requestId is carried so the callback can report which row
// the unlink corresponds to.
export interface DeleteJobData {
  requestId: string;
  filePath: string;
}

export type Status =
  | 'pending'
  | 'downloading'
  | 'guard_review'
  | 'parent_review'
  | 'approved'
  | 'ready'
  | 'rejected'
  | 'failed'
  | 'watched'
  | 'dismissed'
  | 'deleted';

// Stable sentinel stored in `rejection_reason` when a user cancels their own
// download — distinct from freeform reasons set by the guard / parent review.
export const CANCELLED_REASON = '__cancelled_by_user';

// currentStatus is `string` (not `Status`) because the DB can hold statuses
// outside this module's machine-recognized set until later slices broaden it.
export type TransitionResult =
  | { transitioned: true; userId: string }
  | { transitioned: false; currentStatus: string | null };

// Allow-list: source status → permitted destination statuses.
// Subsequent slices fill in entries as they migrate transitions into this module.
export const LEGAL: Record<Status, Status[]> = {
  pending: ['dismissed', 'rejected'],
  downloading: ['ready', 'rejected', 'failed'],
  guard_review: ['rejected'],
  parent_review: ['rejected'],
  approved: ['dismissed', 'rejected'],
  ready: ['watched', 'dismissed', 'deleted'],
  rejected: ['dismissed'],
  failed: ['dismissed'],
  watched: ['dismissed', 'deleted'],
  dismissed: [],
  deleted: ['dismissed'],
};

function legalSourcesFor(target: Status): Status[] {
  return (Object.keys(LEGAL) as Status[]).filter((s) => LEGAL[s].includes(target));
}

// Cancel is bound to user intent and must stay independent of other transitions
// that may also write `rejected` (e.g. guard verdicts). Declared explicitly
// rather than derived from LEGAL so a future non-cancel rejection path can't
// silently broaden cancel eligibility — or, worse, overwrite a guard-set
// rejection_reason with the cancel sentinel.
const CANCELLABLE_FROM: Status[] = [
  'pending',
  'downloading',
  'guard_review',
  'parent_review',
  'approved',
];

function readStatus(id: string): string | null {
  const row = db.prepare(`SELECT status FROM requests WHERE request_id = ?`).get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

// Render a stored `rejection_reason` for kid-facing surfaces. Sentinels become
// human-readable; freeform reasons pass through unchanged.
export function displayRejectionReason(reason: string | null): string | null {
  if (reason === CANCELLED_REASON) return 'Cancelled';
  return reason;
}

// Statuses that should NOT block a fresh re-request for the same video.
// `deleted` belongs here: soft-delete frees disk + removes from feed, but a
// later re-request must produce a brand-new download, not return the dead row.
const DEDUP_TERMINAL: Status[] = ['rejected', 'dismissed', 'watched', 'deleted'];

// Find a still-live request for this user + video that a fresh POST should
// dedup against. Returns null when no such row exists (including when the only
// matching row is in a terminal state — that's the soft-delete re-request path).
export function findActiveDuplicateRequest(
  userId: string,
  youtubeId: string,
): { requestId: string; status: string } | null {
  const placeholders = DEDUP_TERMINAL.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT request_id, status FROM requests
        WHERE user_id = ? AND youtube_id = ?
          AND status NOT IN (${placeholders})
        ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(userId, youtubeId, ...DEDUP_TERMINAL) as
      | { request_id: string; status: string }
      | undefined;
  return row ? { requestId: row.request_id, status: row.status } : null;
}

export function markWatched(id: string): TransitionResult {
  const sources = legalSourcesFor('watched');
  const placeholders = sources.map(() => '?').join(', ');
  const now = new Date().toISOString();

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'watched', watched_at = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(now, id, ...sources) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

export function markDismissed(id: string): TransitionResult {
  const sources = legalSourcesFor('dismissed');
  const placeholders = sources.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'dismissed'
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(id, ...sources) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

export function markSoftDeleted(id: string): TransitionResult {
  const sources = legalSourcesFor('deleted');
  const placeholders = sources.map(() => '?').join(', ');
  const now = new Date().toISOString();

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'deleted', file_state = 'gone', deleted_at = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id, file_path`,
    )
    .get(now, id, ...sources) as { user_id: string; file_path: string | null } | undefined;

  if (!updated) return { transitioned: false, currentStatus: readStatus(id) };

  // The video files live on the Ubuntu worker, not the M4 — so the unlink is
  // delegated via the delete queue. Best-effort: an enqueue failure is
  // logged-warned, not thrown. The row stays `deleted` regardless; an orphaned
  // file is a recoverable nuisance, but rolling back the user's delete intent
  // would be worse.
  if (updated.file_path) {
    const jobData: DeleteJobData = { requestId: id, filePath: updated.file_path };
    void deleteQueue
      .add('delete', jobData, { jobId: `delete:${id}` })
      .catch((err) => logger.warn({ err, requestId: id }, 'markSoftDeleted: failed to enqueue delete job'));
  }

  return { transitioned: true, userId: updated.user_id };
}

export interface DownloadedFields {
  title: string;
  channel: string;
  youtubeChannelId: string | null;
  description: string;
  durationSecs: number;
  transcript: string | null;
  filePath: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
}

export function markDownloaded(id: string, fields: DownloadedFields): TransitionResult {
  const sources = legalSourcesFor('ready');
  const placeholders = sources.map(() => '?').join(', ');
  const now = new Date().toISOString();

  const updated = db
    .prepare(
      `UPDATE requests
         SET status             = 'ready',
             title              = ?,
             channel            = ?,
             youtube_channel_id = ?,
             description        = ?,
             duration_secs      = ?,
             transcript         = ?,
             file_path          = ?,
             nginx_url          = ?,
             thumbnail_url      = ?,
             downloaded_at      = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(
      fields.title,
      fields.channel,
      fields.youtubeChannelId,
      fields.description,
      fields.durationSecs,
      fields.transcript,
      fields.filePath,
      fields.nginxUrl,
      fields.thumbnailUrl,
      now,
      id,
      ...sources,
    ) as { user_id: string } | undefined;

  if (!updated) return { transitioned: false, currentStatus: readStatus(id) };

  const channelId = fields.youtubeChannelId?.trim() ?? '';
  if (channelId) {
    const { personId } = ensurePersonForChannel(channelId, fields.channel);
    void applyChannelInfoToPerson(personId, channelId).catch((err: unknown) =>
      logger.warn({ err, requestId: id, channelId }, 'markDownloaded: failed to capture channel info'),
    );
  }

  // Side-effect fires only after a real transition — a no-op (e.g. user
  // cancelled mid-download) must not page the user that their video is ready.
  // .catch is best-effort: an ntfy outage must not surface as an unhandled
  // rejection, and the row stays `ready` regardless.
  void sendVideoReady(updated.user_id, id, fields.title).catch((err) =>
    logger.warn({ err, requestId: id, userId: updated.user_id }, 'markDownloaded: failed to send video-ready notification'),
  );

  return { transitioned: true, userId: updated.user_id };
}

// Worker terminal download error. Constrained to `downloading` because LEGAL's
// `rejected` destination is reachable from many sources (guard, parent, cancel)
// — those have their own methods and must not collapse into this one.
export function markRejected(id: string, reason: string): TransitionResult {
  const updated = db
    .prepare(
      `UPDATE requests SET status = 'rejected', rejection_reason = ?
       WHERE request_id = ? AND status = 'downloading'
       RETURNING user_id`,
    )
    .get(reason, id) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

// Functionally identical SQL to markRejected — kept distinct so call sites
// reading `state.markGuardBlocked(...)` vs `state.markRejected(...)` reflect
// the actual cause. The endpoint that wraps both still funnels through one
// route; this split is for internal callers that already know the cause.
export function markGuardBlocked(id: string, reason: string): TransitionResult {
  const updated = db
    .prepare(
      `UPDATE requests SET status = 'rejected', rejection_reason = ?
       WHERE request_id = ? AND status = 'downloading'
       RETURNING user_id`,
    )
    .get(reason, id) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

export function markCancelled(id: string): TransitionResult {
  const placeholders = CANCELLABLE_FROM.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'rejected', rejection_reason = ?
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(CANCELLED_REASON, id, ...CANCELLABLE_FROM) as { user_id: string } | undefined;

  if (!updated) return { transitioned: false, currentStatus: readStatus(id) };

  // Side-effects fire only after a real transition — no-ops do not touch Redis
  // or BullMQ. Both are best-effort: a missing job or unreachable Redis must
  // not roll back the cancel.
  void downloadQueue
    .getJob(id)
    .then((job) => job?.remove())
    .catch((err) => logger.warn({ err, requestId: id }, 'Cancel: failed to remove BullMQ job'));
  void redis
    .del(`eddy:progress:${id}`)
    .catch((err) => logger.warn({ err, requestId: id }, 'Cancel: failed to delete progress key'));

  return { transitioned: true, userId: updated.user_id };
}

// Watchdog-only terminal transition for stuck downloads we couldn't re-enqueue.
// No side-effects: the row's job is already gone (or unreachable) by the time
// the watchdog calls this; notifying the user is the watchdog's job, not the
// transition's.
export function markFailed(id: string): TransitionResult {
  const sources = legalSourcesFor('failed');
  const placeholders = sources.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'failed'
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id`,
    )
    .get(id, ...sources) as { user_id: string } | undefined;

  if (updated) return { transitioned: true, userId: updated.user_id };
  return { transitioned: false, currentStatus: readStatus(id) };
}

// Retry sources are declared explicitly rather than via LEGAL: a
// `downloading → downloading` self-loop would clutter the allow-list map, and
// retry is operations-flavoured (re-enqueue), not a typical state transition.
// `failed` (terminal error) re-enters the queue; `downloading` (idempotent
// re-enqueue) covers the watchdog path. Same SQL for both: status stays or
// becomes `downloading`.
const RETRY_FROM: Status[] = ['downloading', 'failed'];

export async function retry(id: string): Promise<TransitionResult> {
  const placeholders = RETRY_FROM.map(() => '?').join(', ');

  const updated = db
    .prepare(
      `UPDATE requests SET status = 'downloading'
       WHERE request_id = ? AND status IN (${placeholders})
       RETURNING user_id, youtube_id, url`,
    )
    .get(id, ...RETRY_FROM) as
      | { user_id: string; youtube_id: string | null; url: string }
      | undefined;

  if (!updated) return { transitioned: false, currentStatus: readStatus(id) };

  // Side-effects fire only after a real transition. Both queue calls are
  // best-effort: a missing job (already gone) or unreachable Redis must not
  // throw out of the transition. The watchdog will pick up rows that end up
  // `downloading` without a live job.
  try {
    const existing = await downloadQueue.getJob(id);
    await existing?.remove();
  } catch (err) {
    logger.warn({ err, requestId: id }, 'Retry: failed to remove existing BullMQ job');
  }

  const jobData: DownloadJobData = {
    requestId: id,
    youtubeId: updated.youtube_id ?? '',
    url: updated.url,
  };

  try {
    await downloadQueue.add('download', jobData, { jobId: id });
  } catch (err) {
    logger.warn({ err, requestId: id }, 'Retry: failed to enqueue BullMQ job');
  }

  return { transitioned: true, userId: updated.user_id };
}

// Per-source constructors below. Each one INSERTs the row and attempts to
// enqueue the download job together — callers can't create a row without also
// attempting to enqueue. Source-specific defaults (`source`, `decided_by`,
// `file_state`) live here so callers pass only intrinsic fields. If
// `downloadQueue.add` throws, the row stays in `downloading` and the watchdog
// will pick it up — matching today's behaviour.

export interface CreateFromShareSheetInput {
  url: string;
  userId: string;
  youtubeId?: string | null;
}

export async function createFromShareSheet(
  input: CreateFromShareSheetInput,
): Promise<{ requestId: string }> {
  const requestId = uuidv7();
  const now = new Date().toISOString();
  const youtubeId = input.youtubeId ?? null;

  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, status, decided_by, decided_at, requested_at, added_at)
     VALUES
       (?, ?, 'share_sheet', ?, ?, 'downloading', 'auto', ?, ?, ?)`,
  ).run(requestId, input.userId, input.url, youtubeId, now, now, now);

  const jobData: DownloadJobData = { requestId, youtubeId: youtubeId ?? '', url: input.url };
  try {
    await downloadQueue.add('download', jobData, { jobId: requestId });
  } catch (err) {
    logger.warn({ err, requestId }, 'createFromShareSheet: failed to enqueue BullMQ job');
  }

  return { requestId };
}

export interface CreateFromChannelPollInput {
  url: string;
  userId: string;
  youtubeId: string;
  youtubeChannelId: string;
  title: string;
  channel: string;
}

export async function createFromChannelPoll(
  input: CreateFromChannelPollInput,
): Promise<{ requestId: string }> {
  const requestId = uuidv7();
  const now = new Date().toISOString();

  // youtube_channel_id populated at insert because the poller already knows it,
  // closing the transient gap where the row would otherwise have NULL channel_id
  // until markDownloaded fires. Keeps the channel-name tap-through working for
  // in-flight follow-poll cards.
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, youtube_channel_id, title, channel, status, requested_at, added_at, file_state)
     VALUES
       (?, ?, 'channel_subscription', ?, ?, ?, ?, ?, 'downloading', ?, ?, 'live')`,
  ).run(
    requestId,
    input.userId,
    input.url,
    input.youtubeId,
    input.youtubeChannelId,
    input.title,
    input.channel,
    now,
    now,
  );

  const jobData: DownloadJobData = { requestId, youtubeId: input.youtubeId, url: input.url };
  try {
    await downloadQueue.add('download', jobData, { jobId: requestId });
  } catch (err) {
    logger.warn({ err, requestId }, 'createFromChannelPoll: failed to enqueue BullMQ job');
  }

  return { requestId };
}

export interface CreateFromCandidateInput {
  url: string;
  userId: string;
  youtubeId: string | null;
  title: string | null;
}

// Candidate accept does not set added_at — preserved from the prior inline
// INSERT in discovery/router.ts. The feed query orders by added_at DESC, but
// recommended cards land in their own section so a NULL there doesn't disturb
// share-sheet ordering.
export async function createFromCandidate(
  input: CreateFromCandidateInput,
): Promise<{ requestId: string }> {
  const requestId = uuidv7();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, title, status, decided_by, decided_at, requested_at)
     VALUES
       (?, ?, 'recommended', ?, ?, ?, 'downloading', 'auto', ?, ?)`,
  ).run(requestId, input.userId, input.url, input.youtubeId, input.title, now, now);

  const jobData: DownloadJobData = {
    requestId,
    youtubeId: input.youtubeId ?? '',
    url: input.url,
  };
  try {
    await downloadQueue.add('download', jobData, { jobId: requestId });
  } catch (err) {
    logger.warn({ err, requestId }, 'createFromCandidate: failed to enqueue BullMQ job');
  }

  return { requestId };
}
