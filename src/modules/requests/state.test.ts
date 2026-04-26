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
  redis: {},
  downloadQueue: {},
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
import { markWatched } from './state';

const USER_ID = '11111111-1111-7111-8111-111111111111';

function insertRequest(opts: {
  request_id: string;
  status: string;
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
