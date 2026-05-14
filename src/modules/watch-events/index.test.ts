import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../queue', () => ({
  redis: { del: vi.fn().mockResolvedValue(1) },
  downloadQueue: { getJob: vi.fn(), add: vi.fn().mockResolvedValue(undefined) },
  deleteQueue: { add: vi.fn().mockResolvedValue(undefined) },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
  closeQueues: vi.fn(),
}));

vi.mock('../notifications', () => ({
  sendVideoReady: vi.fn().mockResolvedValue(undefined),
  sendDownloadAlert: vi.fn(),
  sendParentReview: vi.fn(),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

// requests/state.ts imports the channel-info capture leaf so markDownloaded
// can populate person rows for discovery/share-sheet downloads (#50). That
// leaf transitively pulls yt-dlp (which loads config). vi.importActual on
// state.ts doesn't need any of that — stub it out here.
vi.mock('../people/applyChannelInfo', () => ({
  applyChannelInfoToPerson: vi.fn().mockResolvedValue(undefined),
}));

// Bypass requests/index.ts (which loads config) — re-export the real markWatched
// from state.ts so transitions still hit the in-memory DB end-to-end. Wrapped
// in a vi.fn so tests can assert call counts (e.g. dedup within a batch).
const { markWatchedSpy } = vi.hoisted(() => ({ markWatchedSpy: vi.fn() }));

vi.mock('../requests', async () => {
  const state = await vi.importActual<typeof import('../requests/state')>('../requests/state');
  markWatchedSpy.mockImplementation(state.markWatched);
  return { markWatched: markWatchedSpy };
});

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import {
  meetsWatchedThreshold,
  recordEvents,
  backfillWatchedFromEvents,
  type WatchEventInput,
} from './index';

const USER_ID = '22222222-2222-7222-8222-222222222222';

function insertReadyRequest(requestId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, status, requested_at, added_at)
     VALUES (?, ?, 'share_sheet', 'https://www.youtube.com/watch?v=abc', 'abc12345xyz', 'ready', ?, ?)`,
  ).run(requestId, USER_ID, now, now);
}

function insertRequestRaw(opts: {
  requestId: string;
  status: string;
  watchedAt?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, status, requested_at, added_at, watched_at)
     VALUES (?, ?, 'share_sheet', 'https://www.youtube.com/watch?v=abc', 'abc12345xyz', ?, ?, ?, ?)`,
  ).run(
    opts.requestId,
    USER_ID,
    opts.status,
    now,
    now,
    opts.watchedAt ?? null,
  );
}

function insertEventRaw(opts: {
  requestId: string;
  positionS: number;
  durationS: number;
  reason: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO watch_events
       (event_id, user_id, request_id, video_id, source, started_at, ended_at, position_s, duration_s, reason)
     VALUES (?, ?, ?, 'abc12345xyz', 'feed', ?, ?, ?, ?, ?)`,
  ).run(
    `evt-${opts.requestId}-${opts.reason}-${opts.positionS}`,
    USER_ID,
    opts.requestId,
    now,
    now,
    opts.positionS,
    opts.durationS,
    opts.reason,
  );
}

function makeEvent(overrides: Partial<WatchEventInput> = {}): WatchEventInput {
  const now = new Date().toISOString();
  return {
    userId: USER_ID,
    requestId: 'req-we-1',
    videoId: 'abc12345xyz',
    source: 'feed',
    startedAt: now,
    endedAt: now,
    positionS: 0,
    durationS: 600,
    reason: 'navigated',
    ...overrides,
  };
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM watch_events');
  markWatchedSpy.mockClear();
});

describe('meetsWatchedThreshold', () => {
  it('trips on reason=ended regardless of position', () => {
    expect(meetsWatchedThreshold(makeEvent({ reason: 'ended', positionS: 5, durationS: 600 }))).toBe(true);
  });

  it('trips when position/duration >= 0.9', () => {
    expect(meetsWatchedThreshold(makeEvent({ positionS: 540, durationS: 600 }))).toBe(true);
    expect(meetsWatchedThreshold(makeEvent({ positionS: 600, durationS: 600 }))).toBe(true);
  });

  it('does not trip just below the 0.9 ratio', () => {
    expect(meetsWatchedThreshold(makeEvent({ positionS: 539, durationS: 600 }))).toBe(false);
  });

  it('trips when positionS >= 1500 even if ratio is far below 0.9', () => {
    // 25 minutes into a 2-hour video — clearly engaged, but only 21% complete.
    expect(meetsWatchedThreshold(makeEvent({ positionS: 1500, durationS: 7200 }))).toBe(true);
  });

  it('does not trip below the time floor and below the ratio', () => {
    expect(meetsWatchedThreshold(makeEvent({ positionS: 1499, durationS: 7200 }))).toBe(false);
  });

  it('ignores ratio when durationS is 0 (avoids divide-by-zero false positive)', () => {
    expect(meetsWatchedThreshold(makeEvent({ positionS: 100, durationS: 0 }))).toBe(false);
    expect(meetsWatchedThreshold(makeEvent({ positionS: 1500, durationS: 0 }))).toBe(true);
  });
});

describe('recordEvents', () => {
  it('inserts the event row regardless of threshold', () => {
    insertReadyRequest('req-we-1');
    recordEvents([makeEvent({ reason: 'navigated', positionS: 30, durationS: 600 })]);

    const count = db.prepare('SELECT COUNT(*) AS n FROM watch_events').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('marks the request watched when an ended event arrives', () => {
    insertReadyRequest('req-we-1');
    const before = Date.now();

    recordEvents([makeEvent({ reason: 'ended', positionS: 5, durationS: 600 })]);

    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-we-1') as { status: string; watched_at: string | null };
    expect(row.status).toBe('watched');
    expect(row.watched_at).not.toBeNull();
    expect(new Date(row.watched_at!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('marks the request watched when the ratio threshold trips', () => {
    insertReadyRequest('req-we-1');

    recordEvents([makeEvent({ reason: 'navigated', positionS: 540, durationS: 600 })]);

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-we-1') as { status: string };
    expect(row.status).toBe('watched');
  });

  it('marks the request watched when the time-floor trips on a long-form video', () => {
    insertReadyRequest('req-we-1');

    recordEvents([makeEvent({ reason: 'navigated', positionS: 1500, durationS: 7200 })]);

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-we-1') as { status: string };
    expect(row.status).toBe('watched');
  });

  it('leaves the request unchanged when no threshold trips', () => {
    insertReadyRequest('req-we-1');

    recordEvents([makeEvent({ reason: 'navigated', positionS: 30, durationS: 600 })]);

    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-we-1') as { status: string; watched_at: string | null };
    expect(row.status).toBe('ready');
    expect(row.watched_at).toBeNull();
  });

  it('is idempotent across multiple qualifying events — first watched_at wins', () => {
    // Fake timers so the assertion can't false-pass on ms-granularity coalescing:
    // any erroneous re-write would land at a clearly different ISO timestamp.
    vi.useFakeTimers();
    try {
      insertReadyRequest('req-we-1');

      vi.setSystemTime(new Date('2026-04-29T12:00:00.000Z'));
      recordEvents([makeEvent({ reason: 'ended', positionS: 600, durationS: 600 })]);
      const firstAt = (db
        .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
        .get('req-we-1') as { watched_at: string }).watched_at;

      vi.setSystemTime(new Date('2026-04-29T12:00:01.000Z'));
      recordEvents([makeEvent({ reason: 'ended', positionS: 600, durationS: 600 })]);
      const secondAt = (db
        .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
        .get('req-we-1') as { watched_at: string }).watched_at;

      expect(firstAt).toBe('2026-04-29T12:00:00.000Z');
      expect(secondAt).toBe(firstAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('de-dups within a batch — multiple qualifying events for one request fire markWatched once', () => {
    insertReadyRequest('req-we-1');

    // Three qualifying events for the same requestId in a single POST.
    // Without dedup: markWatched fires three times (extra UPDATE+SELECT each).
    // With dedup: it fires once, then the Set short-circuits the rest.
    recordEvents([
      makeEvent({ reason: 'ended', positionS: 600, durationS: 600 }),
      makeEvent({ reason: 'ended', positionS: 600, durationS: 600 }),
      makeEvent({ reason: 'ended', positionS: 600, durationS: 600 }),
    ]);

    expect(markWatchedSpy).toHaveBeenCalledTimes(1);
    expect(markWatchedSpy).toHaveBeenCalledWith('req-we-1');

    // All three events still recorded — dedup applies only to markWatched calls.
    const count = db.prepare('SELECT COUNT(*) AS n FROM watch_events').get() as { n: number };
    expect(count.n).toBe(3);

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-we-1') as { status: string };
    expect(row.status).toBe('watched');
  });

  it('does not de-dup across distinct requestIds in the same batch', () => {
    insertReadyRequest('req-we-1');
    insertReadyRequest('req-we-2');

    recordEvents([
      makeEvent({ requestId: 'req-we-1', reason: 'ended', positionS: 600, durationS: 600 }),
      makeEvent({ requestId: 'req-we-2', reason: 'ended', positionS: 600, durationS: 600 }),
    ]);

    expect(markWatchedSpy).toHaveBeenCalledTimes(2);
    expect(markWatchedSpy).toHaveBeenNthCalledWith(1, 'req-we-1');
    expect(markWatchedSpy).toHaveBeenNthCalledWith(2, 'req-we-2');
  });
});

describe('backfillWatchedFromEvents', () => {
  it('transitions requests with at least one ended event', () => {
    insertReadyRequest('req-bf-1');
    insertEventRaw({ requestId: 'req-bf-1', positionS: 30, durationS: 600, reason: 'ended' });

    const result = backfillWatchedFromEvents();

    expect(result).toEqual({ candidateRequests: 1, transitioned: 1, alreadyTerminal: 0, missingRequest: 0 });
    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-bf-1') as { status: string; watched_at: string | null };
    expect(row.status).toBe('watched');
    expect(row.watched_at).not.toBeNull();
  });

  it('transitions requests with at least one ratio-qualifying event', () => {
    insertReadyRequest('req-bf-2');
    insertEventRaw({ requestId: 'req-bf-2', positionS: 540, durationS: 600, reason: 'navigated' });

    backfillWatchedFromEvents();

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-bf-2') as { status: string };
    expect(row.status).toBe('watched');
  });

  it('transitions requests with at least one time-floor-qualifying event', () => {
    insertReadyRequest('req-bf-3');
    insertEventRaw({ requestId: 'req-bf-3', positionS: 1500, durationS: 7200, reason: 'navigated' });

    backfillWatchedFromEvents();

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-bf-3') as { status: string };
    expect(row.status).toBe('watched');
  });

  it('leaves requests with only sub-threshold events unchanged', () => {
    insertReadyRequest('req-bf-4');
    insertEventRaw({ requestId: 'req-bf-4', positionS: 30, durationS: 600, reason: 'navigated' });
    insertEventRaw({ requestId: 'req-bf-4', positionS: 60, durationS: 600, reason: 'dismissed' });

    const result = backfillWatchedFromEvents();

    expect(result).toEqual({ candidateRequests: 0, transitioned: 0, alreadyTerminal: 0, missingRequest: 0 });
    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-bf-4') as { status: string; watched_at: string | null };
    expect(row.status).toBe('ready');
    expect(row.watched_at).toBeNull();
  });

  it('counts qualifying events for hard-deleted requests as missingRequest, not alreadyTerminal', () => {
    // watch_events has no FK on request_id (021_watch_events.sql) so signal can
    // outlive a hard-deleted request. The backfill must not silently lump that
    // into alreadyTerminal.
    insertEventRaw({ requestId: 'req-bf-missing', positionS: 600, durationS: 600, reason: 'ended' });

    const result = backfillWatchedFromEvents();

    expect(result).toEqual({ candidateRequests: 1, transitioned: 0, alreadyTerminal: 0, missingRequest: 1 });
  });

  it('counts already-watched rows as alreadyTerminal and does not overwrite watched_at', () => {
    const originalWatchedAt = '2026-01-01T00:00:00.000Z';
    insertRequestRaw({ requestId: 'req-bf-5', status: 'watched', watchedAt: originalWatchedAt });
    insertEventRaw({ requestId: 'req-bf-5', positionS: 600, durationS: 600, reason: 'ended' });

    const result = backfillWatchedFromEvents();

    expect(result).toEqual({ candidateRequests: 1, transitioned: 0, alreadyTerminal: 1, missingRequest: 0 });
    const row = db
      .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
      .get('req-bf-5') as { watched_at: string };
    expect(row.watched_at).toBe(originalWatchedAt);
  });

  it('processes only requests with qualifying events, leaves others alone', () => {
    insertReadyRequest('req-bf-6a');
    insertReadyRequest('req-bf-6b');
    insertEventRaw({ requestId: 'req-bf-6a', positionS: 600, durationS: 600, reason: 'ended' });
    insertEventRaw({ requestId: 'req-bf-6b', positionS: 30, durationS: 600, reason: 'navigated' });

    const result = backfillWatchedFromEvents();

    expect(result).toEqual({ candidateRequests: 1, transitioned: 1, alreadyTerminal: 0, missingRequest: 0 });
    const a = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req-bf-6a') as { status: string };
    const b = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req-bf-6b') as { status: string };
    expect(a.status).toBe('watched');
    expect(b.status).toBe('ready');
  });

  it('is idempotent — re-running after a successful pass is a no-op', () => {
    insertReadyRequest('req-bf-7');
    insertEventRaw({ requestId: 'req-bf-7', positionS: 600, durationS: 600, reason: 'ended' });

    const first = backfillWatchedFromEvents();
    const watchedAtAfterFirst = (db
      .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
      .get('req-bf-7') as { watched_at: string }).watched_at;

    const second = backfillWatchedFromEvents();
    const watchedAtAfterSecond = (db
      .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
      .get('req-bf-7') as { watched_at: string }).watched_at;

    expect(first.transitioned).toBe(1);
    expect(second.transitioned).toBe(0);
    expect(second.alreadyTerminal).toBe(1);
    expect(watchedAtAfterSecond).toBe(watchedAtAfterFirst);
  });
});
