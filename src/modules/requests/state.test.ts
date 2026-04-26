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

const { removeJobMock, getJobMock, redisDelMock } = vi.hoisted(() => ({
  removeJobMock: vi.fn().mockResolvedValue(undefined),
  getJobMock: vi.fn(),
  redisDelMock: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../queue', () => ({
  redis: { del: redisDelMock },
  downloadQueue: { getJob: getJobMock },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
  closeQueues: vi.fn(),
}));

vi.mock('../notifications', () => ({
  sendVideoReady: vi.fn(),
  sendDownloadAlert: vi.fn(),
  sendParentReview: vi.fn(),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import {
  markWatched,
  markDismissed,
  markCancelled,
  CANCELLED_REASON,
  type Status,
} from './state';

const USER_ID = '11111111-1111-7111-8111-111111111111';

function insertRequest(opts: {
  request_id: string;
  status: Status;
  watched_at?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, status, requested_at, added_at, watched_at)
     VALUES (?, ?, 'share_sheet', 'https://www.youtube.com/watch?v=abc', ?, ?, ?, ?)`,
  ).run(opts.request_id, USER_ID, opts.status, now, now, opts.watched_at ?? null);
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  getJobMock.mockReset();
  removeJobMock.mockClear();
  redisDelMock.mockClear();
});

describe('markWatched', () => {
  it('transitions ready → watched and returns the user_id', () => {
    insertRequest({ request_id: 'req-1', status: 'ready' });

    const result = markWatched('req-1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
  });

  it('sets watched_at on the row when the transition succeeds', () => {
    insertRequest({ request_id: 'req-2', status: 'ready' });
    const before = Date.now();

    markWatched('req-2');

    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-2') as { status: string; watched_at: string | null };
    expect(row.status).toBe('watched');
    expect(row.watched_at).not.toBeNull();
    expect(new Date(row.watched_at!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('is a no-op on an already-watched row', () => {
    const originalWatchedAt = '2026-01-01T00:00:00.000Z';
    insertRequest({ request_id: 'req-3', status: 'watched', watched_at: originalWatchedAt });

    const result = markWatched('req-3');

    expect(result).toEqual({ transitioned: false, currentStatus: 'watched' });
    const row = db
      .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
      .get('req-3') as { watched_at: string };
    expect(row.watched_at).toBe(originalWatchedAt);
  });

  it('is a no-op on a rejected row', () => {
    insertRequest({ request_id: 'req-4', status: 'rejected' });

    const result = markWatched('req-4');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-4') as { status: string; watched_at: string | null };
    expect(row.status).toBe('rejected');
    expect(row.watched_at).toBeNull();
  });
});

describe('markDismissed', () => {
  it('transitions ready → dismissed and returns the user_id', () => {
    insertRequest({ request_id: 'req-d1', status: 'ready' });

    const result = markDismissed('req-d1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-d1') as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('is a no-op on a downloading row and does not change status', () => {
    insertRequest({ request_id: 'req-d2', status: 'downloading' });

    const result = markDismissed('req-d2');

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-d2') as { status: string };
    expect(row.status).toBe('downloading');
  });

  it('returns currentStatus: null for an unknown id', () => {
    const result = markDismissed('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('markCancelled', () => {
  it('transitions downloading → rejected with sentinel reason and removes job', async () => {
    insertRequest({ request_id: 'req-c1', status: 'downloading' });
    getJobMock.mockResolvedValueOnce({ remove: removeJobMock });

    const result = markCancelled('req-c1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, rejection_reason FROM requests WHERE request_id = ?')
      .get('req-c1') as { status: string; rejection_reason: string };
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe(CANCELLED_REASON);

    expect(getJobMock).toHaveBeenCalledWith('req-c1');
    expect(redisDelMock).toHaveBeenCalledWith('eddy:progress:req-c1');

    // Let the fire-and-forget chain settle so we can assert remove() ran.
    await new Promise((resolve) => setImmediate(resolve));
    expect(removeJobMock).toHaveBeenCalled();
  });

  it('is a no-op on an already-rejected row and does not call queue or redis', () => {
    insertRequest({ request_id: 'req-c2', status: 'rejected' });

    const result = markCancelled('req-c2');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not call queue', () => {
    const result = markCancelled('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
  });
});
