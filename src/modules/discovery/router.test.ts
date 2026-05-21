import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
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

vi.mock('../requests', () => ({
  getRequestsState: vi.fn(() => ({
    apply: vi.fn(() => ({ result: { transitioned: true, userId: '' }, settled: Promise.resolve() })),
  })),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { discoveryRouter, hasRecentBalancePrompt } from './router';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const INTEREST_ID = '22222222-2222-7222-8222-222222222222';
// A real user with zero interests and zero follows — the empty-profile
// cold-start case. Kept distinct from USER_ID so the no-gate test can't
// accidentally lean on the seeded interest above.
const EMPTY_USER_ID = '33333333-3333-7333-8333-333333333333';

// Minimal mount: the same error-to-status mapping the real server uses, so a
// gate that threw on an empty profile would surface as a 4xx here instead of a
// 200 cold-start response.
const app = express();
app.use(express.json());
app.use('/discovery', discoveryRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
});

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(EMPTY_USER_ID, 'Boy2', 'kid', 10, new Date().toISOString());
  db.prepare(
    'INSERT INTO interests (id, label, search_terms, source) VALUES (?, ?, ?, ?)',
  ).run(INTEREST_ID, 'Robotics', '[]', 'user_added');
});

beforeEach(() => {
  db.exec('DELETE FROM balance_prompts');
  db.exec('DELETE FROM candidate_pool');
});

describe('discovery feed balance prompt cooldown', () => {
  it('ignores a same-cutoff-day prompt that is earlier than the cutoff time', () => {
    const cutoff = db.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') AS cutoff",
    ).get() as { cutoff: string };
    const shownAt = new Date(new Date(cutoff.cutoff).getTime() - 60_000).toISOString();
    expect(shownAt.slice(0, 10)).toBe(cutoff.cutoff.slice(0, 10));

    db.prepare(`
      INSERT INTO balance_prompts
        (prompt_id, user_id, interest_id, interest_label, concentration, shown_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('prompt-1', USER_ID, INTEREST_ID, 'Robotics', 1, shownAt);

    expect(hasRecentBalancePrompt(USER_ID, INTEREST_ID)).toBe(false);
  });
});

describe('discovery feed — no onboarding gate (empty profile reaches cold start)', () => {
  // Issue #160 / ADR-0008: there is no "≥1 interest and ≥1 follow to proceed"
  // gate. A user with zero declared interests and zero follows must reach the
  // feed and land on the cold-start surface, not an error or a forced form.
  it('returns 200 with coldStart=true and no candidates for an empty profile', async () => {
    const res = await supertest(app).get(`/discovery/feed?userId=${EMPTY_USER_ID}`);

    expect(res.status).toBe(200);
    const body = res.body as {
      candidates: unknown[];
      coldStart: boolean;
      balancePrompt: unknown;
    };
    expect(body.coldStart).toBe(true);
    expect(body.candidates).toEqual([]);
    expect(body.balancePrompt).toBeNull();
  });

  it('still reports cold start when the user has interests but no surfaced candidates', async () => {
    // Declaring an interest is not what lifts cold start — having surfaced
    // candidates is. An interest-only profile still proceeds to the feed.
    db.prepare(
      'INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(USER_ID, INTEREST_ID, 1, 'comfortable', 1, new Date().toISOString());

    try {
      const res = await supertest(app).get(`/discovery/feed?userId=${USER_ID}`);

      expect(res.status).toBe(200);
      const body = res.body as { candidates: unknown[]; coldStart: boolean };
      expect(body.coldStart).toBe(true);
      expect(body.candidates).toEqual([]);
    } finally {
      db.prepare(
        'DELETE FROM user_interests WHERE user_id = ? AND interest_id = ?',
      ).run(USER_ID, INTEREST_ID);
    }
  });
});
