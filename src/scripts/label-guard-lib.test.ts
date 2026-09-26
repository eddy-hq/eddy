import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { readUnlabelledEvals } from './label-guard-lib';

const KID = '11111111-1111-7111-8111-111111111111';

function seed(requestId: string, source: string, evalId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO requests (request_id, user_id, source, url, youtube_id, status, requested_at)
    VALUES (?, ?, ?, 'https://www.youtube.com/watch?v=placeholder', 'placeholder', 'ready', ?)
  `).run(requestId, KID, source, now);
  db.prepare(`
    INSERT INTO guard_eval (eval_id, request_id, url, gemma_verdict, gemma_reason, created_at, scored_at)
    VALUES (?, ?, 'https://www.youtube.com/watch?v=placeholder', 'uncertain', 'r', ?, ?)
  `).run(evalId, requestId, now, now);
}

beforeAll(() => {
  runMigrations();
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(KID, 'Boy1', 'kid', 1, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM guard_eval');
  db.exec('DELETE FROM requests');
});

describe('readUnlabelledEvals', () => {
  it('lists unlabelled verdicts on ordinary requests', () => {
    seed('req-own', 'share_sheet', 'eval-own');

    expect(readUnlabelledEvals().map((r) => r.eval_id)).toEqual(['eval-own']);
  });

  it('leaves out a verdict on a request that became a parent pick (#217), keeping the row', () => {
    seed('req-own', 'share_sheet', 'eval-own');
    seed('req-picked', 'recommended', 'eval-picked');
    db.prepare(`UPDATE requests SET source = 'parent_pick' WHERE request_id = 'req-picked'`).run();

    expect(readUnlabelledEvals().map((r) => r.eval_id)).toEqual(['eval-own']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM guard_eval').get()).toEqual({ n: 2 });
  });
});
