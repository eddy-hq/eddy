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

const { removeJobMock, getJobMock, redisDelMock, unlinkMock } = vi.hoisted(() => ({
  removeJobMock: vi.fn().mockResolvedValue(undefined),
  getJobMock: vi.fn(),
  redisDelMock: vi.fn().mockResolvedValue(1),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../queue', () => ({
  redis: { del: redisDelMock },
  downloadQueue: { getJob: getJobMock },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
  closeQueues: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      promises: { ...actual.promises, unlink: unlinkMock },
    },
    promises: { ...actual.promises, unlink: unlinkMock },
  };
});

vi.mock('../notifications', () => ({
  sendVideoReady: vi.fn(),
  sendDownloadAlert: vi.fn(),
  sendParentReview: vi.fn(),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

import { db } from '../../db/client';
import { logger } from '../../logger';
import { runMigrations } from '../../db/migrate';
import {
  markWatched,
  markDismissed,
  markCancelled,
  markSoftDeleted,
  CANCELLED_REASON,
  type Status,
} from './state';

const USER_ID = '11111111-1111-7111-8111-111111111111';

function insertRequest(opts: {
  request_id: string;
  status: Status;
  watched_at?: string | null;
  file_path?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, status, file_path, requested_at, added_at, watched_at)
     VALUES (?, ?, 'share_sheet', 'https://www.youtube.com/watch?v=abc', ?, ?, ?, ?, ?)`,
  ).run(
    opts.request_id,
    USER_ID,
    opts.status,
    opts.file_path ?? null,
    now,
    now,
    opts.watched_at ?? null,
  );
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
  unlinkMock.mockReset();
  unlinkMock.mockResolvedValue(undefined);
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
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

describe('markSoftDeleted', () => {
  const FILE_PATH = '/videos/abc123.mp4';

  it('transitions ready → deleted, sets columns, and unlinks video + sidecars', async () => {
    insertRequest({ request_id: 'req-s1', status: 'ready', file_path: FILE_PATH });
    const before = Date.now();

    const result = markSoftDeleted('req-s1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, file_state, deleted_at FROM requests WHERE request_id = ?')
      .get('req-s1') as { status: string; file_state: string; deleted_at: string | null };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');
    expect(row.deleted_at).not.toBeNull();
    expect(new Date(row.deleted_at!).getTime()).toBeGreaterThanOrEqual(before);

    // Let the fire-and-forget unlink chain settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unlinkMock).toHaveBeenCalledWith(FILE_PATH);
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.en.vtt');
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.en.srt');
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.vtt');
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.srt');
  });

  it('transitions watched → deleted', async () => {
    insertRequest({ request_id: 'req-s2', status: 'watched', file_path: FILE_PATH });

    const result = markSoftDeleted('req-s2');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s2') as { status: string; file_state: string };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');

    await new Promise((resolve) => setImmediate(resolve));
    expect(unlinkMock).toHaveBeenCalledWith(FILE_PATH);
  });

  it('is a no-op on a downloading row and makes no filesystem calls', () => {
    insertRequest({ request_id: 'req-s3', status: 'downloading', file_path: FILE_PATH });

    const result = markSoftDeleted('req-s3');

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s3') as { status: string; file_state: string };
    expect(row.status).toBe('downloading');
    expect(row.file_state).toBe('live');
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('is a no-op on a rejected row and makes no filesystem calls', () => {
    insertRequest({ request_id: 'req-s4', status: 'rejected', file_path: FILE_PATH });

    const result = markSoftDeleted('req-s4');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and makes no filesystem calls', () => {
    const result = markSoftDeleted('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('attempts all five unlinks even when the main video unlink fails (ENOENT) and emits no warn', async () => {
    insertRequest({ request_id: 'req-s5', status: 'ready', file_path: FILE_PATH });
    unlinkMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = markSoftDeleted('req-s5');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    await new Promise((resolve) => setImmediate(resolve));

    // All five paths attempted independently — main video failing does not
    // short-circuit sidecar cleanup.
    expect(unlinkMock).toHaveBeenCalledWith(FILE_PATH);
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.en.vtt');
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.en.srt');
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.vtt');
    expect(unlinkMock).toHaveBeenCalledWith('/videos/abc123.srt');
    expect(unlinkMock).toHaveBeenCalledTimes(5);

    // ENOENT is silent — file already absent is the goal.
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();

    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s5') as { status: string; file_state: string };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');
  });

  it('warn-logs non-ENOENT unlink failures with structured failure list', async () => {
    insertRequest({ request_id: 'req-s6', status: 'ready', file_path: FILE_PATH });
    unlinkMock.mockImplementation((p: string) => {
      if (p === FILE_PATH) return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      if (p === '/videos/abc123.en.vtt') return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(undefined);
    });

    const result = markSoftDeleted('req-s6');
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({
      requestId: 'req-s6',
      failures: [{ path: FILE_PATH, code: 'EACCES' }],
    });
  });
});
