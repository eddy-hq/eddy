import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
}));

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
  discoveryQueue: { add: vi.fn() },
  guardQueue: {},
  downloadQueue: {},
  thumbsQueue: {},
  deleteQueue: {},
}));

vi.mock('../guard/index', () => ({
  evaluateCandidate: vi.fn(),
}));

vi.mock('../../ytdlp', () => ({
  searchVideosWithDates: vi.fn(),
  flatPlaylistChannel: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { pruneStalePool } from './index';

const USER_ID = '11111111-1111-7111-8111-111111111111';

function insertCandidate(opts: {
  candidate_id: string;
  status: string;
  ageDays: number;
  createdAt?: string;
}): void {
  const created = opts.createdAt ?? new Date(Date.now() - opts.ageDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type,
       url, external_id, status, created_at)
    VALUES (?, ?, 'video', 'interest_search', ?, ?, ?, ?)
  `).run(
    opts.candidate_id,
    USER_ID,
    `https://www.youtube.com/watch?v=${opts.candidate_id}`,
    opts.candidate_id,
    opts.status,
    created,
  );
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
});

describe('pruneStalePool', () => {
  it('drops pending and scored rows older than 30 days', () => {
    insertCandidate({ candidate_id: 'old-pending', status: 'pending', ageDays: 40 });
    insertCandidate({ candidate_id: 'old-scored', status: 'scored', ageDays: 40 });

    pruneStalePool();

    const rows = db.prepare('SELECT candidate_id FROM candidate_pool').all() as Array<{ candidate_id: string }>;
    expect(rows).toEqual([]);
  });

  it('keeps fresh pending and scored rows', () => {
    insertCandidate({ candidate_id: 'fresh-pending', status: 'pending', ageDays: 5 });
    insertCandidate({ candidate_id: 'fresh-scored', status: 'scored', ageDays: 5 });

    pruneStalePool();

    const rows = db.prepare('SELECT candidate_id FROM candidate_pool ORDER BY candidate_id').all() as Array<{ candidate_id: string }>;
    expect(rows.map((r) => r.candidate_id)).toEqual(['fresh-pending', 'fresh-scored']);
  });

  it('drops a stale same-cutoff-day ISO row earlier than the cutoff time', () => {
    const cutoff = db.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AS cutoff",
    ).get() as { cutoff: string };
    const createdAt = new Date(new Date(cutoff.cutoff).getTime() - 60_000).toISOString();
    expect(createdAt.slice(0, 10)).toBe(cutoff.cutoff.slice(0, 10));
    insertCandidate({ candidate_id: 'same-day-stale', status: 'pending', ageDays: 0, createdAt });

    pruneStalePool();

    const row = db.prepare('SELECT candidate_id FROM candidate_pool WHERE candidate_id = ?')
      .get('same-day-stale');
    expect(row).toBeUndefined();
  });

  it('leaves old terminal rows alone (they are history, not dead weight)', () => {
    insertCandidate({ candidate_id: 'old-surfaced', status: 'surfaced', ageDays: 60 });
    insertCandidate({ candidate_id: 'old-dismissed', status: 'dismissed', ageDays: 60 });
    insertCandidate({ candidate_id: 'old-requested', status: 'requested', ageDays: 60 });
    insertCandidate({ candidate_id: 'old-scored', status: 'scored', ageDays: 60 });

    pruneStalePool();

    const rows = db.prepare('SELECT candidate_id FROM candidate_pool ORDER BY candidate_id').all() as Array<{ candidate_id: string }>;
    expect(rows.map((r) => r.candidate_id)).toEqual([
      'old-dismissed', 'old-requested', 'old-surfaced',
    ]);
  });
});
