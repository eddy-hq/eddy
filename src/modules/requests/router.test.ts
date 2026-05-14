import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  config: {
    PORT: 3737,
    TAILSCALE_IP: '127.0.0.1',
  },
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn(), del: vi.fn() },
  downloadQueue: { getJob: vi.fn() },
  deleteQueue: { add: vi.fn() },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn().mockResolvedValue(undefined) }),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { readRecentRejectedRequestsForAdmin } from './index';

const USER_ID = '11111111-1111-7111-8111-111111111111';

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
});

describe('requests admin pipeline recency window', () => {
  it('excludes a same-cutoff-day rejected request earlier than the cutoff time', () => {
    const cutoff = db.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours') AS cutoff",
    ).get() as { cutoff: string };
    const requestedAt = new Date(new Date(cutoff.cutoff).getTime() - 60_000).toISOString();
    expect(requestedAt.slice(0, 10)).toBe(cutoff.cutoff.slice(0, 10));

    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, status, rejection_reason, requested_at, added_at)
      VALUES (?, ?, 'share_sheet', ?, 'rejected', ?, ?, ?)
    `).run(
      'request-1',
      USER_ID,
      'https://www.youtube.com/watch?v=request-1',
      'Not suitable',
      requestedAt,
      requestedAt,
    );

    expect(readRecentRejectedRequestsForAdmin()).toEqual([]);
  });
});
