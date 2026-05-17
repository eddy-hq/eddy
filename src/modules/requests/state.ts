import { db } from '../../db/client';
import { logger } from '../../logger';
import type { DownloadJobData } from '../content';

// The state machine deliberately does not import `../notifications`,
// `../../queue`, or `../people/registry` here. Those are side-effect-heavy
// production dependencies wired up through the `Ports` seam below; the
// default port bindings live in `./state-default.ts`. Keeping them off this
// file's static import graph lets the test suite (and any future caller)
// construct the module with fake ports without dragging BullMQ, Redis, and
// ntfy into a unit test's startup path.

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

// ─── Ports ───────────────────────────────────────────────────────────────────
//
// Every side-effect dependency state.ts used to import directly is declared
// here so a test (or the next-slice rewrite) can construct the module with
// fakes. Production callers pass `defaultPorts()` via `createRequestsState`.
// The function signatures intentionally match the upstream APIs verbatim so
// the production wiring is a one-line lambda per port.

export interface DownloadQueueJobOptions {
  jobId: string;
}

export interface Ports {
  notifyVideoReady: (userId: string, requestId: string, title: string) => Promise<void>;
  enqueueDownload: (jobData: DownloadJobData, opts: DownloadQueueJobOptions) => Promise<unknown>;
  enqueueDelete: (jobData: DeleteJobData, opts: DownloadQueueJobOptions) => Promise<unknown>;
  // Wraps `downloadQueue.getJob(id).then(j => j?.remove())` — the seam handles
  // both "job present, remove" and "job absent" paths so descriptor effects
  // don't need to know about BullMQ. May resolve/reject; callers decide whether
  // to await or fire-and-forget based on the calling descriptor.
  cancelDownloadJob: (requestId: string) => Promise<void>;
  redisDel: (key: string) => Promise<number | unknown>;
  ensurePerson: (
    channelId: string,
    channelName: string,
  ) => { personId: string; created: boolean };
  applyChannelInfo: (personId: string, channelId: string) => Promise<void>;
}

// ─── Events ──────────────────────────────────────────────────────────────────
//
// One event per existing per-verb export. The shape mirrors the descriptor's
// `buildSql` inputs so the SQL builder is a pure function over (event, now).

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
  // Bytes on disk at download completion — feeds the per-user recycler budget
  // (issue #113). Nullable because pre-#114 rows that never get backfilled
  // (e.g. file already gone) will stay null; the recycler treats null as
  // "not counted yet" rather than "zero bytes".
  fileSizeBytes: number | null;
}

export interface CreateFromShareSheetInput {
  url: string;
  userId: string;
  youtubeId?: string | null;
}

export interface CreateFromChannelPollInput {
  url: string;
  userId: string;
  youtubeId: string;
  youtubeChannelId: string;
  title: string;
  channel: string;
}

export interface CreateFromCandidateInput {
  url: string;
  userId: string;
  youtubeId: string | null;
  title: string | null;
  whyText: string | null;
}

// Fields supplied by the worker on a successful restore (issue #116).
// Mirrors the subset of `DownloadedFields` that mark_restored re-populates:
// file_path / nginx_url / thumbnail_url / file_size_bytes. Title, channel,
// description, transcript, duration and youtube_channel_id are deliberately
// excluded — those were captured on the original download and re-writing them
// would needlessly churn columns the PWA already shows. The restore is a
// "bring back the bytes" action, not a "re-discover the video" one.
export interface RestoredFields {
  filePath: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
  fileSizeBytes: number | null;
}

export type Event =
  | { kind: 'mark_watched'; requestId: string }
  | { kind: 'mark_soft_deleted'; requestId: string }
  | { kind: 'mark_recycled'; requestId: string }
  | { kind: 'mark_restored'; requestId: string; fields: RestoredFields }
  | { kind: 'mark_downloaded'; requestId: string; fields: DownloadedFields }
  | { kind: 'mark_rejected'; requestId: string; reason: string }
  | { kind: 'mark_guard_blocked'; requestId: string; reason: string }
  | { kind: 'mark_cancelled'; requestId: string }
  | { kind: 'mark_failed'; requestId: string }
  | { kind: 'retry'; requestId: string }
  | { kind: 'create_share_sheet'; requestId: string; input: CreateFromShareSheetInput }
  | { kind: 'create_channel_poll'; requestId: string; input: CreateFromChannelPollInput }
  | { kind: 'create_candidate'; requestId: string; input: CreateFromCandidateInput };

// ─── Effects ─────────────────────────────────────────────────────────────────
//
// Discriminated union: every side effect the dispatcher knows how to execute.
// `enqueue_download` vs the two `cancel_*` variants encode the await-or-fire
// distinction the descriptor table relies on (the `retry` descriptor awaits
// and try/catches the cancel; `mark_cancelled` fires-and-forgets). Adding a
// new effect kind forces a dispatcher branch — the `never` check at the end
// of `runEffect` makes a missing case a typecheck error, not a silent
// fall-through.

export type Effect =
  | { kind: 'notify_video_ready'; userId: string; requestId: string; title: string }
  | { kind: 'enqueue_download'; jobData: DownloadJobData; logRequestId: string; logMessage: string }
  | { kind: 'enqueue_delete'; jobData: DeleteJobData; requestId: string }
  | { kind: 'cancel_download_job_fire'; requestId: string }
  | { kind: 'cancel_download_job_awaited'; requestId: string }
  | { kind: 'redis_del'; key: string; requestId: string }
  | { kind: 'ensure_person_capture'; channelId: string; channelName: string };

// ─── Descriptor table ────────────────────────────────────────────────────────

interface Descriptor<E extends Event> {
  // `'creation'` flags an INSERT-shaped descriptor (no source-status gate).
  sources: Status[] | 'creation';
  // The post-transition `status` value. `'preserve'` signals that `status` is
  // left untouched (the descriptor mutates other columns only — e.g. the
  // recycler flips `file_state` without disturbing the user-facing tier).
  target: Status | 'preserve';
  buildSql: (event: E, now: string) => { sql: string; params: unknown[] };
  // Optional read-only SELECT executed inside the same transaction as the
  // main UPDATE, *before* it runs. Its row is merged into __sqlResult so
  // `effects(...)` can read pre-update column values. Used by mark_recycled
  // to capture file_path before the UPDATE clears it (SQLite RETURNING only
  // sees the post-update row). Returning undefined means "no pre-fetch".
  preFetch?: (event: E) => { sql: string; params: unknown[] } | undefined;
  effects: (event: E, result: TransitionResult) => Effect[];
}

// Cancel allow-list (was the standalone CANCELLABLE_FROM array): user-intent
// cancel must stay independent of other transitions that may also write
// `rejected` (e.g. guard verdicts). Declared inline on the descriptor rather
// than derived from a global LEGAL map so a future non-cancel rejection path
// can't silently broaden cancel eligibility — or, worse, overwrite a
// guard-set rejection_reason with the cancel sentinel.
const CANCELLABLE_SOURCES: Status[] = [
  'pending',
  'downloading',
  'guard_review',
  'parent_review',
  'approved',
];

// Retry sources are explicit: a `downloading → downloading` self-loop is the
// watchdog's idempotent re-enqueue path; `failed` (terminal error) re-enters
// the queue. Same SQL for both. Declared on the descriptor rather than via a
// LEGAL allow-list: retry is operations-flavoured, not a typical transition.
const RETRY_SOURCES: Status[] = ['downloading', 'failed'];

// Exported for the property test in state.test.ts — it walks every
// `(Event type × source status)` pair off this table at runtime so the
// descriptor and the test cannot drift. Not part of the public state API
// outside tests; production callers go through `apply`.
export const TRANSITIONS = {
  mark_watched: {
    sources: ['ready'],
    target: 'watched',
    buildSql: (event, now) => ({
      sql: `UPDATE requests SET status = 'watched', watched_at = ?
            WHERE request_id = ? AND status IN ('ready')
            RETURNING user_id`,
      params: [now, event.requestId],
    }),
    effects: () => [],
  } as Descriptor<Extract<Event, { kind: 'mark_watched' }>>,

  mark_soft_deleted: {
    sources: ['ready', 'watched'],
    target: 'deleted',
    buildSql: (event, now) => ({
      // file_size_bytes is cleared alongside the file_state flip so the
      // recycler's per-user accounting (#113) never counts bytes that aren't
      // on disk any more. Issue #114 contract: file_size_bytes is null for
      // every row without a live file.
      sql: `UPDATE requests
              SET status          = 'deleted',
                  file_state      = 'gone',
                  file_size_bytes = NULL,
                  deleted_at      = ?
            WHERE request_id = ? AND status IN ('ready', 'watched')
            RETURNING user_id, file_path`,
      params: [now, event.requestId],
    }),
    effects: (event, result) => {
      // The file path is captured in the RETURNING clause and stashed on the
      // SqlResult below — we read it back here. Only emit the delete effect
      // when the transition actually fired AND the row had a file to remove.
      const sqlResult = (result as SqlResultCarrier).__sqlResult;
      const filePath = sqlResult?.['file_path'] as string | null | undefined;
      if (!result.transitioned || !filePath) return [];
      return [{ kind: 'enqueue_delete', jobData: { requestId: event.requestId, filePath }, requestId: event.requestId }];
    },
  } as Descriptor<Extract<Event, { kind: 'mark_soft_deleted' }>>,

  // Recycler (issue #115): per-user budget reclamation. Same row symmetry as
  // mark_soft_deleted (file_state flips off live; bytes/file_path/nginx_url
  // cleared so the row no longer pretends to have a playable file) but
  // `status` is preserved — the card stays in its tier (watched / dismissed
  // / ready) so the timeline keeps its shape and the restore path (#116)
  // can put the file back without rewriting history.
  //
  // The picker upstream is responsible for the saved-immunity and 48h
  // skip rules; this descriptor is intentionally permissive on those — if
  // an event arrives, the row was already deemed eligible.
  mark_recycled: {
    sources: ['ready', 'watched', 'dismissed'],
    target: 'preserve',
    preFetch: (event) => ({
      // Capture the pre-UPDATE file_path; the SET clause below clears the
      // column and SQLite's RETURNING only sees the post-update value, so
      // without this peek there's nothing for the unlink effect to consume.
      sql: `SELECT file_path AS pre_file_path FROM requests WHERE request_id = ?`,
      params: [event.requestId],
    }),
    buildSql: (event, now) => ({
      sql: `UPDATE requests
              SET file_state      = 'recycled',
                  recycled_at     = ?,
                  file_path       = NULL,
                  nginx_url       = NULL,
                  file_size_bytes = NULL
            WHERE request_id = ?
              AND status IN ('ready', 'watched', 'dismissed')
              AND file_state = 'live'
            RETURNING user_id`,
      params: [now, event.requestId],
    }),
    effects: (event, result) => {
      // Only enqueue when the transition actually fired AND the row carried
      // a file path. The preFetch row (merged into __sqlResult by runSql)
      // exposes the pre-update path under `pre_file_path`.
      const sqlResult = (result as SqlResultCarrier).__sqlResult;
      const filePath = sqlResult?.['pre_file_path'] as string | null | undefined;
      if (!result.transitioned || !filePath) return [];
      return [{ kind: 'enqueue_delete', jobData: { requestId: event.requestId, filePath }, requestId: event.requestId }];
    },
  } as Descriptor<Extract<Event, { kind: 'mark_recycled' }>>,

  // Restore (issue #116): the worker has re-downloaded a previously-recycled
  // file. Reverses what `mark_recycled` did — re-populates file_path,
  // nginx_url, thumbnail_url and file_size_bytes; clears recycled_at; flips
  // file_state back to `live`. `status` is preserved (a watched row stays
  // watched, a dismissed row stays dismissed) because the original verdict
  // was a real engagement signal the restore must not erase.
  //
  // Source-status list mirrors mark_recycled's, but the gate that actually
  // decides eligibility is `file_state = 'recycled'` in the UPDATE WHERE —
  // status is just the descriptor table's coarse filter. No notify effect:
  // restore is an in-PWA action the user just initiated; surprising them
  // with a `video_ready` ntfy would be noise. No ensure_person_capture
  // either — the person row already exists from the original mark_downloaded.
  mark_restored: {
    sources: ['ready', 'watched', 'dismissed'],
    target: 'preserve',
    buildSql: (event) => ({
      sql: `UPDATE requests
              SET file_state      = 'live',
                  recycled_at     = NULL,
                  file_path       = ?,
                  nginx_url       = ?,
                  thumbnail_url   = COALESCE(thumbnail_url, ?),
                  file_size_bytes = ?
            WHERE request_id = ?
              AND status IN ('ready', 'watched', 'dismissed')
              AND file_state = 'recycled'
            RETURNING user_id`,
      params: [
        event.fields.filePath,
        event.fields.nginxUrl,
        // COALESCE order is deliberate: existing row value first, payload
        // second. The worker always sends the maxresdefault fallback on
        // every download — without this ordering it would overwrite an
        // editorial-upgrade pick captured on the original download, and
        // since the thumb-upgrade job is skipped on restore there'd be no
        // recovery. Falls back to the payload only when the row has no
        // thumbnail yet (a pre-#43 edge case worth handling defensively).
        event.fields.thumbnailUrl,
        event.fields.fileSizeBytes,
        event.requestId,
      ],
    }),
    effects: () => [],
  } as Descriptor<Extract<Event, { kind: 'mark_restored' }>>,

  mark_downloaded: {
    sources: ['downloading'],
    target: 'ready',
    buildSql: (event, now) => ({
      sql: `UPDATE requests
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
                  file_size_bytes    = ?,
                  downloaded_at      = ?
            WHERE request_id = ? AND status IN ('downloading')
            RETURNING user_id`,
      params: [
        event.fields.title,
        event.fields.channel,
        event.fields.youtubeChannelId,
        event.fields.description,
        event.fields.durationSecs,
        event.fields.transcript,
        event.fields.filePath,
        event.fields.nginxUrl,
        event.fields.thumbnailUrl,
        event.fields.fileSizeBytes,
        now,
        event.requestId,
      ],
    }),
    effects: (event, result) => {
      if (!result.transitioned) return [];
      const list: Effect[] = [
        {
          kind: 'notify_video_ready',
          userId: result.userId,
          requestId: event.requestId,
          title: event.fields.title,
        },
      ];
      // Discovery and share-sheet requests don't know the channel at INSERT
      // time — it lands here when the worker callback fires. Channel-poll
      // requests already route through ensurePersonForChannel on follow, so
      // ensure_person is a no-op for them; capturing channel info is gated
      // on `created` inside the dispatcher.
      if (event.fields.youtubeChannelId) {
        list.push({
          kind: 'ensure_person_capture',
          channelId: event.fields.youtubeChannelId,
          channelName: event.fields.channel,
        });
      }
      return list;
    },
  } as Descriptor<Extract<Event, { kind: 'mark_downloaded' }>>,

  // mark_rejected and mark_guard_blocked share identical SQL — kept distinct so
  // call sites reflect the actual cause. Both gate on `downloading` only:
  // LEGAL's `rejected` destination is reachable from several sources (guard,
  // parent, cancel), and those have their own descriptors which must not
  // collapse into this one.
  mark_rejected: {
    sources: ['downloading'],
    target: 'rejected',
    buildSql: (event) => ({
      sql: `UPDATE requests SET status = 'rejected', rejection_reason = ?
            WHERE request_id = ? AND status = 'downloading'
            RETURNING user_id`,
      params: [event.reason, event.requestId],
    }),
    effects: () => [],
  } as Descriptor<Extract<Event, { kind: 'mark_rejected' }>>,

  mark_guard_blocked: {
    sources: ['downloading'],
    target: 'rejected',
    buildSql: (event) => ({
      sql: `UPDATE requests SET status = 'rejected', rejection_reason = ?
            WHERE request_id = ? AND status = 'downloading'
            RETURNING user_id`,
      params: [event.reason, event.requestId],
    }),
    effects: () => [],
  } as Descriptor<Extract<Event, { kind: 'mark_guard_blocked' }>>,

  mark_cancelled: {
    sources: CANCELLABLE_SOURCES,
    target: 'rejected',
    buildSql: (event) => {
      const placeholders = CANCELLABLE_SOURCES.map(() => '?').join(', ');
      return {
        sql: `UPDATE requests SET status = 'rejected', rejection_reason = ?
              WHERE request_id = ? AND status IN (${placeholders})
              RETURNING user_id`,
        params: [CANCELLED_REASON, event.requestId, ...CANCELLABLE_SOURCES],
      };
    },
    effects: (event, result) => {
      if (!result.transitioned) return [];
      return [
        { kind: 'cancel_download_job_fire', requestId: event.requestId },
        { kind: 'redis_del', key: `eddy:progress:${event.requestId}`, requestId: event.requestId },
      ];
    },
  } as Descriptor<Extract<Event, { kind: 'mark_cancelled' }>>,

  // Watchdog-only terminal transition for stuck downloads we couldn't
  // re-enqueue. No side-effects: the row's job is already gone (or
  // unreachable) by the time the watchdog calls this; notifying the user is
  // the watchdog's job, not the transition's.
  mark_failed: {
    sources: ['downloading'],
    target: 'failed',
    buildSql: (event) => ({
      sql: `UPDATE requests SET status = 'failed'
            WHERE request_id = ? AND status IN ('downloading')
            RETURNING user_id`,
      params: [event.requestId],
    }),
    effects: () => [],
  } as Descriptor<Extract<Event, { kind: 'mark_failed' }>>,

  retry: {
    sources: RETRY_SOURCES,
    target: 'downloading',
    buildSql: (event) => {
      const placeholders = RETRY_SOURCES.map(() => '?').join(', ');
      return {
        sql: `UPDATE requests SET status = 'downloading'
              WHERE request_id = ? AND status IN (${placeholders})
              RETURNING user_id, youtube_id, url`,
        params: [event.requestId, ...RETRY_SOURCES],
      };
    },
    effects: (event, result) => {
      if (!result.transitioned) return [];
      const sqlResult = (result as SqlResultCarrier).__sqlResult;
      const youtubeId = (sqlResult?.['youtube_id'] as string | null) ?? '';
      const url = sqlResult?.['url'] as string;
      const jobData: DownloadJobData = { requestId: event.requestId, youtubeId, url };
      return [
        { kind: 'cancel_download_job_awaited', requestId: event.requestId },
        {
          kind: 'enqueue_download',
          jobData,
          logRequestId: event.requestId,
          logMessage: 'Retry: failed to enqueue BullMQ job',
        },
      ];
    },
  } as Descriptor<Extract<Event, { kind: 'retry' }>>,

  create_share_sheet: {
    sources: 'creation',
    target: 'downloading',
    buildSql: (event, now) => ({
      sql: `INSERT INTO requests
              (request_id, user_id, source, url, youtube_id, status, decided_by, decided_at, requested_at, added_at)
            VALUES
              (?, ?, 'share_sheet', ?, ?, 'downloading', 'auto', ?, ?, ?)`,
      params: [
        event.requestId,
        event.input.userId,
        event.input.url,
        event.input.youtubeId ?? null,
        now,
        now,
        now,
      ],
    }),
    effects: (event) => [{
      kind: 'enqueue_download',
      jobData: {
        requestId: event.requestId,
        youtubeId: event.input.youtubeId ?? '',
        url: event.input.url,
      },
      logRequestId: event.requestId,
      logMessage: 'create_share_sheet: failed to enqueue BullMQ job',
    }],
  } as Descriptor<Extract<Event, { kind: 'create_share_sheet' }>>,

  // youtube_channel_id is populated at insert because the poller already
  // knows it, closing the transient gap where the row would otherwise have
  // NULL channel_id until mark_downloaded fires. Keeps the channel-name
  // tap-through working for in-flight follow-poll cards.
  create_channel_poll: {
    sources: 'creation',
    target: 'downloading',
    buildSql: (event, now) => ({
      sql: `INSERT INTO requests
              (request_id, user_id, source, url, youtube_id, youtube_channel_id, title, channel, status, requested_at, added_at, file_state)
            VALUES
              (?, ?, 'channel_subscription', ?, ?, ?, ?, ?, 'downloading', ?, ?, 'live')`,
      params: [
        event.requestId,
        event.input.userId,
        event.input.url,
        event.input.youtubeId,
        event.input.youtubeChannelId,
        event.input.title,
        event.input.channel,
        now,
        now,
      ],
    }),
    effects: (event) => [{
      kind: 'enqueue_download',
      jobData: {
        requestId: event.requestId,
        youtubeId: event.input.youtubeId,
        url: event.input.url,
      },
      logRequestId: event.requestId,
      logMessage: 'create_channel_poll: failed to enqueue BullMQ job',
    }],
  } as Descriptor<Extract<Event, { kind: 'create_channel_poll' }>>,

  // added_at matches the other two creators: the feed query orders by
  // `added_at DESC LIMIT 200`, so a NULL there pushes the row below every
  // dated request and out of the cap entirely — the candidate accept then
  // looks like a silent dismiss in the PWA.
  create_candidate: {
    sources: 'creation',
    target: 'downloading',
    buildSql: (event, now) => ({
      sql: `INSERT INTO requests
              (request_id, user_id, source, url, youtube_id, title, why_text, status, decided_by, decided_at, requested_at, added_at)
            VALUES
              (?, ?, 'recommended', ?, ?, ?, ?, 'downloading', 'auto', ?, ?, ?)`,
      params: [
        event.requestId,
        event.input.userId,
        event.input.url,
        event.input.youtubeId,
        event.input.title,
        event.input.whyText,
        now,
        now,
        now,
      ],
    }),
    effects: (event) => [{
      kind: 'enqueue_download',
      jobData: {
        requestId: event.requestId,
        youtubeId: event.input.youtubeId ?? '',
        url: event.input.url,
      },
      logRequestId: event.requestId,
      logMessage: 'create_candidate: failed to enqueue BullMQ job',
    }],
  } as Descriptor<Extract<Event, { kind: 'create_candidate' }>>,
} as const;

// Internal: descriptors stash the raw SQL row off the result so `effects(...)`
// can read columns the public TransitionResult doesn't expose (e.g.
// `file_path` for soft-delete, `youtube_id`/`url` for retry). Never escapes
// the module; the public API returns a clean TransitionResult.
type SqlResultCarrier = TransitionResult & { __sqlResult?: Record<string, unknown> };

// ─── Apply / dispatch ────────────────────────────────────────────────────────

// Outcome of a single `apply(event)` call. The SQL write is synchronous, so
// `result` is available immediately. `settled` resolves once every effect's
// returned promise has settled — fire-and-forget effects (e.g. ntfy send) do
// not contribute to it; only effects that genuinely need sequencing (BullMQ
// `enqueue_download`, `cancel_download_job_awaited`) do. Sync callers ignore
// `settled`; async callers (retry / creators) `await` it before returning so
// the pre-refactor sequencing guarantees survive.
export type ApplyOutcome = {
  result: TransitionResult;
  settled: Promise<void>;
};

export interface RequestsState {
  apply: (event: Event) => ApplyOutcome;
}

export function createRequestsState({ ports }: { ports: Ports }): RequestsState {
  // ── runEffect: exhaustively switch every Effect.kind. Adding a new kind
  // without a branch is a compile error via the `never` check at the bottom.
  // Best-effort semantics live here so descriptors stay declarative.
  function runEffect(effect: Effect): Promise<void> | void {
    switch (effect.kind) {
      case 'notify_video_ready': {
        // Fire-and-forget: an ntfy outage must not surface as an unhandled
        // rejection, and the row stays `ready` regardless of notification.
        void ports
          .notifyVideoReady(effect.userId, effect.requestId, effect.title)
          .catch((err) =>
            logger.warn(
              { err, requestId: effect.requestId, userId: effect.userId },
              'mark_downloaded: failed to send video-ready notification',
            ),
          );
        return;
      }
      case 'enqueue_download': {
        // Awaited try/catch: caller (retry / creators) is responsible for
        // ensuring the job is enqueued before its promise resolves; failure
        // logs once and is swallowed (the watchdog will pick stuck rows up).
        return (async () => {
          try {
            await ports.enqueueDownload(effect.jobData, { jobId: effect.jobData.requestId });
          } catch (err) {
            logger.warn({ err, requestId: effect.logRequestId }, effect.logMessage);
          }
        })();
      }
      case 'enqueue_delete': {
        // Fire-and-forget: an enqueue failure is logged-warned, not thrown.
        // The row stays `deleted` regardless; an orphaned file is a
        // recoverable nuisance, but rolling back the user's delete intent
        // would be worse.
        void ports
          .enqueueDelete(effect.jobData, { jobId: `delete-${effect.requestId}` })
          .catch((err) =>
            logger.warn({ err, requestId: effect.requestId }, 'mark_soft_deleted: failed to enqueue delete job'),
          );
        return;
      }
      case 'cancel_download_job_fire': {
        // mark_cancelled path: best-effort, a missing job or unreachable
        // Redis must not roll back the cancel.
        void ports
          .cancelDownloadJob(effect.requestId)
          .catch((err) => logger.warn({ err, requestId: effect.requestId }, 'Cancel: failed to remove BullMQ job'));
        return;
      }
      case 'cancel_download_job_awaited': {
        // Retry path: must complete before the new enqueue runs to avoid the
        // BullMQ "duplicate jobId" race. Try/catch swallows missing-job /
        // Redis-down — the next enqueue is the substantive op.
        return (async () => {
          try {
            await ports.cancelDownloadJob(effect.requestId);
          } catch (err) {
            logger.warn({ err, requestId: effect.requestId }, 'Retry: failed to remove existing BullMQ job');
          }
        })();
      }
      case 'redis_del': {
        // Fire-and-forget: same rationale as cancel_download_job_fire.
        void ports
          .redisDel(effect.key)
          .catch((err) => logger.warn({ err, requestId: effect.requestId }, 'Cancel: failed to delete progress key'));
        return;
      }
      case 'ensure_person_capture': {
        // Best-effort person capture on download. `ensurePerson` is synchronous
        // and writes to the DB, so it can throw — wrap it so a transient DB
        // error doesn't surface as an unhandled rejection inside `apply`'s
        // settled chain (which sync apply callers don't observe). The
        // transition itself has already succeeded; person capture is a side
        // concern.
        // The follow-up `applyChannelInfo` capture is logged at `debug`
        // because yt-dlp flakes are routine.
        try {
          const { personId, created } = ports.ensurePerson(effect.channelId, effect.channelName);
          if (created) {
            void ports
              .applyChannelInfo(personId, effect.channelId)
              .catch((err) =>
                logger.debug({ err, channelId: effect.channelId }, 'Capture channel info on download failed'),
              );
          }
        } catch (err) {
          logger.warn(
            { err, channelId: effect.channelId },
            'mark_downloaded: failed to ensure person on download',
          );
        }
        return;
      }
      default: {
        // Exhaustiveness check: a missing branch fails the typecheck rather
        // than silently no-op'ing an unrecognised effect.
        const _exhaustive: never = effect;
        throw new Error(`Unhandled effect kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // runSql: shared SQL-execution core for both the async apply seam and the
  // sync per-verb shims. Resolves the descriptor, builds and runs the SQL,
  // and returns the carrier (with `__sqlResult` stashed for descriptors that
  // need to read RETURNING columns inside `effects(...)`).
  //
  // If the descriptor declares a `preFetch` SELECT, it runs inside a
  // transaction wrapping the UPDATE, and its row's columns are merged into
  // `__sqlResult` (UPDATE RETURNING columns win on key collision). This is
  // the seam mark_recycled uses to surface the pre-UPDATE file_path that
  // the SET clause would otherwise null out before RETURNING sees it.
  function runSql(event: Event): { descriptor: Descriptor<Event>; result: SqlResultCarrier } {
    const now = new Date().toISOString();
    const descriptor = TRANSITIONS[event.kind] as Descriptor<Event>;
    const { sql, params } = descriptor.buildSql(event, now);

    if (descriptor.sources === 'creation') {
      // Creation events INSERT and don't return a row; treat the insert as
      // always-transitioned. `userId` is empty because creation effects don't
      // read it back — they take the requestId/userId off the event itself.
      db.prepare(sql).run(...params);
      return { descriptor, result: { transitioned: true, userId: '' } };
    }

    // Run preFetch + UPDATE atomically so a concurrent writer can't slip in
    // a change between the two reads. better-sqlite3 transactions are
    // synchronous, which matches the dispatcher's existing all-sync DB
    // contract; if the UPDATE filter rejects the row, the preFetch read is
    // discarded along with it.
    let preFetched: Record<string, unknown> | undefined;
    let row: Record<string, unknown> | undefined;
    const tx = db.transaction(() => {
      if (descriptor.preFetch) {
        const p = descriptor.preFetch(event);
        if (p) preFetched = db.prepare(p.sql).get(...p.params) as Record<string, unknown> | undefined;
      }
      row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    });
    tx();

    if (row) {
      // Merge order: preFetch fields first, UPDATE RETURNING columns on top
      // so a column name that appears in both wins as the post-update value.
      // The recycler's preFetch deliberately uses a distinct key (pre_file_path)
      // so its value is never shadowed by a same-named RETURNING column.
      const merged = preFetched ? { ...preFetched, ...row } : row;
      return {
        descriptor,
        result: { transitioned: true, userId: row['user_id'] as string, __sqlResult: merged },
      };
    }
    return {
      descriptor,
      result: {
        transitioned: false,
        currentStatus: readStatus((event as Extract<Event, { requestId: string }>).requestId),
      },
    };
  }

  function stripCarrier(result: SqlResultCarrier): TransitionResult {
    if (result.transitioned) return { transitioned: true, userId: result.userId };
    return { transitioned: false, currentStatus: result.currentStatus };
  }

  // ── apply: the single seam every status mutation flows through. The SQL
  // write is synchronous, so `result` is available on return. Effects fire
  // in declared order: each runEffect runs synchronously to kick off its
  // work, and if it returns a promise the loop awaits it before invoking
  // the next runEffect. That sequencing is load-bearing for `retry`, whose
  // descriptor must finish `cancel_download_job_awaited` before
  // `enqueue_download` runs (otherwise BullMQ sees the old jobId still
  // present and rejects the new enqueue). `settled` resolves once the
  // chain has drained.
  function apply(event: Event): ApplyOutcome {
    const { descriptor, result } = runSql(event);
    const effects = descriptor.effects(event, result);
    const settled = (async () => {
      for (const effect of effects) {
        const ret = runEffect(effect);
        if (ret) await ret;
      }
    })();
    return { result: stripCarrier(result), settled };
  }

  return { apply };
}

// Production wiring lives in ./state-default.ts so this file's static imports
// stay free of the side-effect-heavy port providers (BullMQ, ntfy,
// people/registry). See state-default.ts for the boot-time
// `registerDefaultRequestsState` seam and the `getRequestsState` accessor
// that production call sites use to reach `apply`.
