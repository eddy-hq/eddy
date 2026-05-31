import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError } from '../../errors';
import { getRequestsState, type TransitionResult } from '../requests';

export const watchEventsRouter = Router();

const VALID_SOURCES = new Set([
  'feed', 'discovery', 'search', 'channel', 'history',
  'saved', 'notification', 'direct', 'person',
]);
const VALID_REASONS = new Set(['ended', 'dismissed', 'navigated', 'backgrounded']);

// Absolute-time floor for "watched": long-form videos where 90% is unrealistic
// but 25 minutes of continuous engagement is clearly a watch.
// Exported so other modules (profile-enrichment) reuse the same threshold
// rather than redefining it — see issue #58.
export const WATCHED_TIME_FLOOR_S = 1500;
export const WATCHED_RATIO = 0.9;

export interface WatchEventInput {
  userId: string;
  requestId: string;
  videoId: string;
  source: string;
  startedAt: string;
  endedAt: string;
  positionS: number;
  durationS: number;
  reason: string;
}

export function meetsWatchedThreshold(e: WatchEventInput): boolean {
  if (e.reason === 'ended') return true;
  if (e.durationS > 0 && e.positionS / e.durationS >= WATCHED_RATIO) return true;
  if (e.positionS >= WATCHED_TIME_FLOOR_S) return true;
  return false;
}

function validate(e: unknown, idx: number): WatchEventInput {
  if (!e || typeof e !== 'object') throw new ValidationError(`events[${idx}] must be an object`);
  const r = e as Record<string, unknown>;
  const str = (k: string): string => {
    const v = r[k];
    if (typeof v !== 'string' || !v) throw new ValidationError(`events[${idx}].${k} must be a non-empty string`);
    return v;
  };
  const int = (k: string): number => {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ValidationError(`events[${idx}].${k} must be a non-negative number`);
    }
    return Math.round(v);
  };

  const source = str('source');
  if (!VALID_SOURCES.has(source)) throw new ValidationError(`events[${idx}].source invalid: ${source}`);
  const reason = str('reason');
  if (!VALID_REASONS.has(reason)) throw new ValidationError(`events[${idx}].reason invalid: ${reason}`);

  return {
    userId: str('userId'),
    requestId: str('requestId'),
    videoId: str('videoId'),
    source,
    startedAt: str('startedAt'),
    endedAt: str('endedAt'),
    positionS: int('positionS'),
    durationS: int('durationS'),
    reason,
  };
}

const INSERT_SQL = `
  INSERT INTO watch_events
    (event_id, user_id, request_id, video_id, source, started_at, ended_at, position_s, duration_s, reason)
  VALUES
    (@event_id, @user_id, @request_id, @video_id, @source, @started_at, @ended_at, @position_s, @duration_s, @reason)
`;

// Records each event and, in the same transaction, derives `requests.watched_at`
// when an event crosses the threshold. The mark_watched event is itself
// idempotent, but we de-dup within the batch so a single POST with multiple
// qualifying events for the same requestId only issues one UPDATE+SELECT
// pair, not N.
export function recordEvents(events: WatchEventInput[]): void {
  const insert = db.prepare(INSERT_SQL);
  const tx = db.transaction((batch: WatchEventInput[]) => {
    const marked = new Set<string>();
    for (const e of batch) {
      insert.run({
        event_id: uuidv7(),
        user_id: e.userId,
        request_id: e.requestId,
        video_id: e.videoId,
        source: e.source,
        started_at: e.startedAt,
        ended_at: e.endedAt,
        position_s: e.positionS,
        duration_s: e.durationS,
        reason: e.reason,
      });
      if (meetsWatchedThreshold(e) && !marked.has(e.requestId)) {
        getRequestsState().apply({ kind: 'mark_watched', requestId: e.requestId });
        marked.add(e.requestId);
      }
    }
  });
  tx(events);
}

// One-shot backfill for `requests.watched_at`: scans the existing watch_events
// stream, finds every request_id with at least one event meeting the
// threshold, and replays the mark_watched event against it. Idempotent —
// re-running after a partial run is safe because mark_watched no-ops on
// already-watched rows. Returns counts so callers (the CLI script, tests)
// can log/assert.
//
// Threshold mirrors meetsWatchedThreshold() — if the predicate above changes,
// update this query too. Kept as raw SQL so the backfill is a single scan
// instead of streaming every row into JS.
// `missingRequest` is real, not a counter for diagnostic colour: watch_events
// has no FK on request_id (021_watch_events.sql) so signal can outlive a
// hard-deleted request. We split it from `alreadyTerminal` so the backfill
// log distinguishes "already counted" from "row gone".
export interface BackfillResult {
  candidateRequests: number;
  transitioned: number;
  alreadyTerminal: number;
  missingRequest: number;
}

export function findRequestsWithQualifyingEvents(): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT request_id FROM watch_events
    WHERE reason = 'ended'
       OR (duration_s > 0 AND CAST(position_s AS REAL) / duration_s >= ?)
       OR position_s >= ?
  `).all(WATCHED_RATIO, WATCHED_TIME_FLOOR_S) as Array<{ request_id: string }>;
  return rows.map((r) => r.request_id);
}

export function backfillWatchedFromEvents(): BackfillResult {
  const ids = findRequestsWithQualifyingEvents();
  let transitioned = 0;
  let alreadyTerminal = 0;
  let missingRequest = 0;
  const stateMachine = getRequestsState();
  for (const id of ids) {
    const result: TransitionResult = stateMachine.apply({
      kind: 'mark_watched',
      requestId: id,
    }).result;
    if (result.transitioned) transitioned += 1;
    else if (result.currentStatus === null) missingRequest += 1;
    else alreadyTerminal += 1;
  }
  return { candidateRequests: ids.length, transitioned, alreadyTerminal, missingRequest };
}

// POST /watch-events — batched, append-only. Body: { events: [...] }
watchEventsRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as { events?: unknown };
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new ValidationError('events must be a non-empty array');
  }
  if (body.events.length > 50) throw new ValidationError('events batch limit is 50');

  const validated = body.events.map((e, i) => validate(e, i));
  recordEvents(validated);

  logger.info({ count: validated.length }, 'Watch events recorded');
  res.status(204).end();
});
