import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ValidationError } from '../../errors';

export const watchEventsRouter = Router();

const VALID_SOURCES = new Set([
  'feed', 'discovery', 'search', 'channel', 'history',
  'saved', 'notification', 'direct',
]);
const VALID_REASONS = new Set(['ended', 'dismissed', 'navigated', 'backgrounded']);

interface WatchEventInput {
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

const insertStmt = db.prepare(`
  INSERT INTO watch_events
    (event_id, user_id, request_id, video_id, source, started_at, ended_at, position_s, duration_s, reason)
  VALUES
    (@event_id, @user_id, @request_id, @video_id, @source, @started_at, @ended_at, @position_s, @duration_s, @reason)
`);

const insertMany = db.transaction((events: WatchEventInput[]) => {
  for (const e of events) {
    insertStmt.run({
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
  }
});

// POST /watch-events — batched, append-only. Body: { events: [...] }
watchEventsRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as { events?: unknown };
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new ValidationError('events must be a non-empty array');
  }
  if (body.events.length > 50) throw new ValidationError('events batch limit is 50');

  const validated = body.events.map((e, i) => validate(e, i));
  insertMany(validated);

  logger.info({ count: validated.length }, 'Watch events recorded');
  res.status(204).end();
});
