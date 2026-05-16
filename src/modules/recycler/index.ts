import { Worker } from 'bullmq';
import { config } from '../../config';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { recyclerQueue, redis } from '../../queue';
import { getRequestsState } from '../requests';

// ─── Recycler module (issue #115) ────────────────────────────────────────────
//
// Per-user storage budget enforcement with a global hard cap as a second
// guard. Runs nightly on the M4 (04:00 local). For each user over
// `USER_STORAGE_QUOTA_BYTES`, picks live-file rows in priority order and
// fires `mark_recycled` until they're back under quota. After the per-user
// sweep, if the global live-file total still exceeds
// `GLOBAL_STORAGE_CAP_BYTES`, keeps picking across all users in the same
// priority order until back under.
//
// Priority order (first-to-recycle → last):
//   1. status = 'dismissed', oldest by `added_at`
//   2. status = 'watched',  oldest by latest `watch_events.ended_at`
//      (so re-watched videos stay alive longer). The issue brief says
//      `created_at`; that column doesn't exist on the table (see
//      `src/db/migrations/021_watch_events.sql`) — `ended_at` is the
//      closest equivalent and matches the intent ("when did the user
//      last engage with this video").
//   3. status = 'ready'    (unwatched), oldest by `added_at`,
//      *skipping anything `added_at` within the last 48h*
//   4. `saved_at IS NOT NULL` rows are NEVER picked, regardless of status
//
// The state machine event (`mark_recycled`) handles the row mutation +
// delete-queue enqueue; this module is purely the picker + scheduler.

// Window during which a freshly-added unwatched row is exempt from
// recycling. Gives the user a fair shot at watching before the system
// reclaims the file. 48 hours per the spec (docs/brief.md §6).
const READY_SKIP_WINDOW_MS = 48 * 60 * 60 * 1000;

// Internal: a candidate victim. The picker generators yield victims in
// priority-then-secondary-sort order, so the consumer just iterates — no
// tier comparison is needed at the call site.
interface Victim {
  requestId: string;
  userId: string;
  fileSizeBytes: number;
}

// Two filters, not one. ON_DISK counts every row whose bytes are actually
// taking up space (live + sized) — saved or not. PICK_ELIGIBLE narrows that
// to rows the picker is *allowed* to recycle (live + sized + not saved).
//
// Why the split: a user with 100 GiB of saved videos sits at 100% of their
// budget and the recycler can do nothing about it — that's by design (saved
// is the explicit "keep this" gesture). But the picker still needs to know
// the user is over so it can reach for any *unsaved* live bytes they have.
// If we excluded saved bytes from the total, the over-budget signal would
// be invisible and the picker would no-op even when there's eligible
// content to free.
//
// file_state = 'live' is the recycler's only handle on whether bytes are
// still on disk — file_size_bytes-null rows are excluded because they're
// either pre-#114 (not backfilled) or already gone.
const ON_DISK_FILTER = `
  file_state = 'live'
  AND file_size_bytes IS NOT NULL
`;

const PICK_ELIGIBLE_FILTER = `
  file_state = 'live'
  AND saved_at IS NULL
  AND file_size_bytes IS NOT NULL
`;

// Sum live bytes per user. Users with no live files are absent from the
// result (we don't need a row for them).
interface UserSizeRow {
  user_id: string;
  total_bytes: number;
}

function readPerUserLiveBytes(): UserSizeRow[] {
  return db.prepare(`
    SELECT user_id, SUM(file_size_bytes) AS total_bytes
    FROM requests
    WHERE ${ON_DISK_FILTER}
    GROUP BY user_id
  `).all() as UserSizeRow[];
}

function readGlobalLiveBytes(): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(file_size_bytes), 0) AS total_bytes
    FROM requests
    WHERE ${ON_DISK_FILTER}
  `).get() as { total_bytes: number };
  return row.total_bytes;
}

// Pick candidate victims for a single user, in priority order. Returns a
// generator so the caller can stop the instant the running total brings the
// user back under quota — we don't speculatively pull rows we'll discard.
//
// Tier 1 — dismissed, oldest by added_at
// Tier 2 — watched, oldest by latest watch_events.ended_at
//          (re-watched stays alive longer; rows with no events fall back
//           to watched_at, then added_at, all oldest-first)
// Tier 3 — ready, oldest by added_at, *excluding* rows added within the
//          last 48h. The cutoff is computed in JS so it's deterministic
//          across the per-user and global passes.
function* pickUserVictims(userId: string, readyCutoffIso: string): Generator<Victim> {
  // Tier 1: dismissed
  const dismissed = db.prepare(`
    SELECT request_id, user_id, file_size_bytes
    FROM requests
    WHERE user_id = ?
      AND status = 'dismissed'
      AND ${PICK_ELIGIBLE_FILTER}
    ORDER BY added_at ASC, request_id ASC
  `).all(userId) as Array<{ request_id: string; user_id: string; file_size_bytes: number }>;
  for (const row of dismissed) {
    yield { requestId: row.request_id, userId: row.user_id, fileSizeBytes: row.file_size_bytes };
  }

  // Tier 2: watched, ordered by latest watch_events.ended_at. The LEFT
  // JOIN + MAX() captures "most-recent watch event for this request";
  // COALESCE falls back to watched_at then added_at so a watched row with
  // no events still has a deterministic position (oldest-first).
  // Eligibility filter is inlined here (instead of reusing
  // PICK_ELIGIBLE_FILTER) because the columns need the `r.` qualifier
  // under the JOIN — the constant is unqualified for the single-table
  // queries above and below.
  const watched = db.prepare(`
    SELECT r.request_id, r.user_id, r.file_size_bytes
    FROM requests r
    LEFT JOIN (
      SELECT request_id, MAX(ended_at) AS last_event_at
      FROM watch_events
      GROUP BY request_id
    ) we ON we.request_id = r.request_id
    WHERE r.user_id = ?
      AND r.status = 'watched'
      AND r.file_state = 'live'
      AND r.saved_at IS NULL
      AND r.file_size_bytes IS NOT NULL
    ORDER BY COALESCE(we.last_event_at, r.watched_at, r.added_at) ASC, r.request_id ASC
  `).all(userId) as Array<{ request_id: string; user_id: string; file_size_bytes: number }>;
  for (const row of watched) {
    yield { requestId: row.request_id, userId: row.user_id, fileSizeBytes: row.file_size_bytes };
  }

  // Tier 3: ready (unwatched), oldest by added_at, skipping the 48h grace
  // window. The cutoff parameter is bound at the JS layer so per-user and
  // global passes use the same wall-clock anchor.
  const ready = db.prepare(`
    SELECT request_id, user_id, file_size_bytes
    FROM requests
    WHERE user_id = ?
      AND status = 'ready'
      AND added_at < ?
      AND ${PICK_ELIGIBLE_FILTER}
    ORDER BY added_at ASC, request_id ASC
  `).all(userId, readyCutoffIso) as Array<{ request_id: string; user_id: string; file_size_bytes: number }>;
  for (const row of ready) {
    yield { requestId: row.request_id, userId: row.user_id, fileSizeBytes: row.file_size_bytes };
  }
}

// Global picker for the second pass. Same priority tiers as per-user, but
// pooled across all users. We can't reuse pickUserVictims directly because
// the global ordering is "all tier-1 rows from any user, then all tier-2,
// then all tier-3" — the tier boundary is global, not per-user.
function* pickGlobalVictims(readyCutoffIso: string, excluded: Set<string>): Generator<Victim> {
  const tiers: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `
        SELECT request_id, user_id, file_size_bytes
        FROM requests
        WHERE status = 'dismissed'
          AND ${PICK_ELIGIBLE_FILTER}
        ORDER BY added_at ASC, request_id ASC
      `,
      params: [],
    },
    {
      sql: `
        SELECT r.request_id, r.user_id, r.file_size_bytes
        FROM requests r
        LEFT JOIN (
          SELECT request_id, MAX(ended_at) AS last_event_at
          FROM watch_events
          GROUP BY request_id
        ) we ON we.request_id = r.request_id
        WHERE r.status = 'watched'
          AND r.file_state = 'live'
          AND r.saved_at IS NULL
          AND r.file_size_bytes IS NOT NULL
        ORDER BY COALESCE(we.last_event_at, r.watched_at, r.added_at) ASC, r.request_id ASC
      `,
      params: [],
    },
    {
      sql: `
        SELECT request_id, user_id, file_size_bytes
        FROM requests
        WHERE status = 'ready'
          AND added_at < ?
          AND ${PICK_ELIGIBLE_FILTER}
        ORDER BY added_at ASC, request_id ASC
      `,
      params: [readyCutoffIso],
    },
  ];

  for (const { sql, params } of tiers) {
    const rows = db.prepare(sql).all(...params) as Array<{
      request_id: string; user_id: string; file_size_bytes: number;
    }>;
    for (const row of rows) {
      if (excluded.has(row.request_id)) continue;
      yield {
        requestId: row.request_id,
        userId: row.user_id,
        fileSizeBytes: row.file_size_bytes,
      };
    }
  }
}

export interface RecyclerPassResult {
  perUserRecycled: number;
  globalRecycled: number;
  bytesFreed: number;
}

// One pass = one per-user sweep over every user that's over budget, then
// one global sweep if the live total is still over the hard cap. Returns
// counters for caller logging.
//
// The picker does no I/O outside DB reads + the state-machine `apply`
// call. `mark_recycled` itself enqueues the file unlink via the existing
// delete queue, so a worker crash mid-pass leaves the rows correctly
// marked and a stale enqueue in Redis — recoverable.
export function runRecyclerPass(): RecyclerPassResult {
  const readyCutoffIso = new Date(Date.now() - READY_SKIP_WINDOW_MS).toISOString();
  const state = getRequestsState();

  let perUserRecycled = 0;
  let bytesFreed = 0;
  const recycledIds = new Set<string>();

  // Per-user sweep. Skip users at-or-under budget. For users over, pull
  // victims until the running per-user total is back under quota. The
  // running total tracks bytes the picker *believes* it has freed; the
  // descriptor enqueues the unlink fire-and-forget, so the on-disk state
  // catches up asynchronously, but the DB accounting is consistent the
  // instant `apply` returns (file_size_bytes is nulled in the SQL update).
  const perUser = readPerUserLiveBytes();
  for (const { user_id, total_bytes } of perUser) {
    if (total_bytes <= config.USER_STORAGE_QUOTA_BYTES) continue;

    let remaining = total_bytes - config.USER_STORAGE_QUOTA_BYTES;
    for (const victim of pickUserVictims(user_id, readyCutoffIso)) {
      if (remaining <= 0) break;
      const outcome = state.apply({ kind: 'mark_recycled', requestId: victim.requestId });
      if (!outcome.result.transitioned) continue;
      recycledIds.add(victim.requestId);
      perUserRecycled += 1;
      remaining -= victim.fileSizeBytes;
      bytesFreed += victim.fileSizeBytes;
    }
  }

  // Global sweep. Re-read the live total because the per-user sweep may
  // have already brought us under the global cap (or close to it).
  let globalRecycled = 0;
  let globalRemaining = readGlobalLiveBytes() - config.GLOBAL_STORAGE_CAP_BYTES;
  if (globalRemaining > 0) {
    for (const victim of pickGlobalVictims(readyCutoffIso, recycledIds)) {
      if (globalRemaining <= 0) break;
      const outcome = state.apply({ kind: 'mark_recycled', requestId: victim.requestId });
      if (!outcome.result.transitioned) continue;
      recycledIds.add(victim.requestId);
      globalRecycled += 1;
      globalRemaining -= victim.fileSizeBytes;
      bytesFreed += victim.fileSizeBytes;
    }
  }

  return { perUserRecycled, globalRecycled, bytesFreed };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
//
// Daily repeatable at 04:00 local — strictly before profile-enrichment
// (05:00) and discovery (06:00) so the morning's discovery sees the
// freshly-freed bytes and doesn't pad the candidate pool against a feed
// the recycler is about to thin out. Same shape as
// startDiscoveryScheduler (src/modules/discovery/index.ts) and
// startProfileEnrichmentScheduler (src/modules/profile-enrichment/index.ts).

let recyclerWorker: Worker | null = null;

export function startRecyclerScheduler(): void {
  void recyclerQueue.add('run', {}, {
    repeat: { pattern: '0 4 * * *' },
    jobId: 'recycler-daily',
  }).catch((err: unknown) => logger.warn({ err }, 'Recycler: failed to schedule repeatable job'));

  recyclerWorker = new Worker('recycler', async (job) => {
    if (job.name === 'run') {
      logger.info('Recycler pass started');
      const result = runRecyclerPass();
      logger.info(result, 'Recycler pass complete');
    }
  }, { connection: redis, concurrency: 1 });

  recyclerWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Recycler job completed');
  });
  recyclerWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Recycler job failed');
  });

  logger.info('Recycler scheduler started (daily at 04:00)');
}

export async function stopRecyclerScheduler(): Promise<void> {
  if (recyclerWorker) {
    await recyclerWorker.close();
    recyclerWorker = null;
  }
}
