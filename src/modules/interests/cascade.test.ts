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
  interestsQueue: { add: vi.fn() },
  guardQueue: { add: vi.fn() },
  discoveryQueue: { add: vi.fn() },
  downloadQueue: { add: vi.fn() },
  thumbsQueue: { add: vi.fn() },
  deleteQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { removeUserInterest } from './index';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_USER = '22222222-2222-7222-8222-222222222222';
const INTEREST_ID = 'ai_product_strategy';
const KEEP_INTEREST = 'philosophy';

function insertCandidate(opts: {
  candidate_id: string;
  user_id?: string;
  interest_id: string | null;
  status: string;
}): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, interest_id,
       url, external_id, status, created_at)
    VALUES (?, ?, 'video', 'interest_search', ?, ?, ?, ?, ?)
  `).run(
    opts.candidate_id,
    opts.user_id ?? USER_ID,
    opts.interest_id,
    `https://www.youtube.com/watch?v=${opts.candidate_id}`,
    opts.candidate_id,
    opts.status,
    new Date().toISOString(),
  );
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, now);
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(OTHER_USER, 'Boy2', 'kid', 10, now);
  db.prepare(
    'INSERT INTO interests (id, label, category) VALUES (?, ?, ?)',
  ).run(INTEREST_ID, 'AI product strategy', 'tech');
  db.prepare(
    'INSERT INTO interests (id, label, category) VALUES (?, ?, ?)',
  ).run(KEEP_INTEREST, 'Philosophy', 'humanities');
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM user_interests');
  db.prepare(
    'INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(USER_ID, INTEREST_ID, 1, 'comfortable', new Date().toISOString());
  db.prepare(
    'INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(USER_ID, KEEP_INTEREST, 2, 'comfortable', new Date().toISOString());
});

describe('removeUserInterest', () => {
  it('removes the user_interests row', () => {
    removeUserInterest(USER_ID, INTEREST_ID);

    const remaining = db.prepare(
      'SELECT interest_id FROM user_interests WHERE user_id = ?'
    ).all(USER_ID) as Array<{ interest_id: string }>;
    expect(remaining.map((r) => r.interest_id)).toEqual([KEEP_INTEREST]);
  });

  it('drops in-flight candidates tagged with the removed interest', () => {
    insertCandidate({ candidate_id: 'c-pending', interest_id: INTEREST_ID, status: 'pending' });
    insertCandidate({ candidate_id: 'c-scored', interest_id: INTEREST_ID, status: 'scored' });
    insertCandidate({ candidate_id: 'c-guardp', interest_id: INTEREST_ID, status: 'guard_pending' });
    insertCandidate({ candidate_id: 'c-guardr', interest_id: INTEREST_ID, status: 'guard_rejected' });

    removeUserInterest(USER_ID, INTEREST_ID);

    const rows = db.prepare(
      'SELECT candidate_id FROM candidate_pool WHERE user_id = ?'
    ).all(USER_ID) as Array<{ candidate_id: string }>;
    expect(rows).toEqual([]);
  });

  it('keeps surfaced/dismissed/requested candidates so history is preserved', () => {
    insertCandidate({ candidate_id: 'c-surfaced', interest_id: INTEREST_ID, status: 'surfaced' });
    insertCandidate({ candidate_id: 'c-dismissed', interest_id: INTEREST_ID, status: 'dismissed' });
    insertCandidate({ candidate_id: 'c-requested', interest_id: INTEREST_ID, status: 'requested' });

    removeUserInterest(USER_ID, INTEREST_ID);

    const rows = db.prepare(
      'SELECT candidate_id FROM candidate_pool WHERE user_id = ? ORDER BY candidate_id'
    ).all(USER_ID) as Array<{ candidate_id: string }>;
    expect(rows.map((r) => r.candidate_id)).toEqual([
      'c-dismissed', 'c-requested', 'c-surfaced',
    ]);
  });

  it('leaves candidates tagged with other interests untouched', () => {
    insertCandidate({ candidate_id: 'c-keep', interest_id: KEEP_INTEREST, status: 'scored' });
    insertCandidate({ candidate_id: 'c-drop', interest_id: INTEREST_ID, status: 'scored' });

    removeUserInterest(USER_ID, INTEREST_ID);

    const rows = db.prepare(
      'SELECT candidate_id FROM candidate_pool WHERE user_id = ?'
    ).all(USER_ID) as Array<{ candidate_id: string }>;
    expect(rows.map((r) => r.candidate_id)).toEqual(['c-keep']);
  });

  it('does not touch other users\' candidates with the same interest_id', () => {
    insertCandidate({
      candidate_id: 'c-other', user_id: OTHER_USER, interest_id: INTEREST_ID, status: 'scored',
    });

    removeUserInterest(USER_ID, INTEREST_ID);

    const rows = db.prepare(
      'SELECT candidate_id FROM candidate_pool WHERE user_id = ?'
    ).all(OTHER_USER) as Array<{ candidate_id: string }>;
    expect(rows.map((r) => r.candidate_id)).toEqual(['c-other']);
  });
});
