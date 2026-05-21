import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// ─── Module mocks ────────────────────────────────────────────────────────────
//
// The `:memory:` DB is a real fixture so the cold-start branch the feed route
// takes is the real SQL path. The requests state machine is mocked because the
// cold-start path never reaches it — the GET /feed handler only resolves the
// user and reads the (empty) candidate pool. Mocking it keeps Redis/BullMQ out.

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
  getRequestsState: vi.fn(() => ({ apply: vi.fn() })),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { discoveryRouter } from './router';

// ─── Express harness ────────────────────────────────────────────────────────
//
// Same error-to-status mapping the real server uses, so a thrown error would
// surface as a non-200 here. That matters for this test: the whole point is
// that an empty-profile user does NOT trip an onboarding gate (which would be a
// 4xx) and does NOT hit an unhandled throw (a 500) — they reach the cold-start
// surface on a clean 200.

const app = express();
app.use(express.json());
app.use('/discovery', discoveryRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL', message: String(err) });
});

const EMPTY_PROFILE_USER_ID = '99999999-9999-7999-8999-999999999999';

beforeAll(() => {
  runMigrations();
  // A brand-new user: registered, but zero declared interests, zero follows,
  // zero candidates. The deliberate point is that nothing seeds discovery —
  // this is the cold state ADR-0008 and brief §9a call valid.
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(EMPTY_PROFILE_USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

// Regression guard for the dropped onboarding gate (issue #160, parent #155).
// There is no "≥1 interest and ≥1 follow to proceed" requirement: a user with
// an empty profile must reach the feed's cold-start surface, never an error or
// a forced setup form.
describe('discovery feed cold-start for an empty profile', () => {
  it('serves the cold-start surface to a user with zero interests and zero follows', async () => {
    const res = await supertest(app).get(`/discovery/feed?userId=${EMPTY_PROFILE_USER_ID}`);

    // Reached the feed on a clean 200 — no gate (4xx) and no unhandled throw (500).
    expect(res.status).toBe(200);

    // The cold-start state, not content and not a forced form.
    expect(res.body.coldStart).toBe(true);
    expect(res.body.candidates).toEqual([]);

    // No balance prompt is manufactured out of an empty feed.
    expect(res.body.balancePrompt).toBeNull();
  });
});
