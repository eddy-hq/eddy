import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../requests', () => ({
  getRequestsState: vi.fn(() => ({
    apply: vi.fn(() => ({ result: { transitioned: true, userId: '' }, settled: Promise.resolve() })),
  })),
}));

import express from 'express';
import supertest from 'supertest';
import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { discoveryRouter } from './router';

const USER_ID = '11111111-1111-7111-8111-111111111111';

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, url, external_id,
       title, guard_verdict, status, created_at)
    VALUES ('cand-1', ?, 'video', 'interest_search', 'https://www.youtube.com/watch?v=cand-1',
            'cand-1', 'Placeholder', NULL, 'scored', ?)
  `).run(USER_ID, new Date().toISOString());
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/discovery', discoveryRouter);
  return a;
}

function candidateStatus(): string {
  return (db.prepare('SELECT status FROM candidate_pool WHERE candidate_id = ?')
    .get('cand-1') as { status: string }).status;
}

// The daily slate (surfaceForToday, ADR-0009) is the only way a candidate
// reaches a feed. These routes predate it, skipped its predicates (guard
// verdict, why_text, blocked channels) and had no caller, so they were
// removed rather than hardened (#199). This pins that they stay gone.
describe('removed discovery routes', () => {
  it('POST /discovery/request is gone, so a never-guarded candidate cannot be requested', async () => {
    const res = await supertest(app())
      .post('/discovery/request')
      .send({ userId: USER_ID, candidateId: 'cand-1' });
    expect(res.status).toBe(404);
    expect(candidateStatus()).toBe('scored');
  });

  it('POST /discovery/dismiss is gone', async () => {
    const res = await supertest(app())
      .post('/discovery/dismiss')
      .send({ userId: USER_ID, candidateId: 'cand-1' });
    expect(res.status).toBe(404);
    expect(candidateStatus()).toBe('scored');
  });

  it('GET /discovery/feed is gone', async () => {
    const res = await supertest(app()).get(`/discovery/feed?userId=${USER_ID}`);
    expect(res.status).toBe(404);
  });
});
