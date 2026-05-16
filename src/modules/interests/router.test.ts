import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks ────────────────────────────────────────────────────────────
//
// Real `:memory:` SQLite so the SQL the router runs is the real SQL and the
// guard_eval row insert lands somewhere we can assert on. Side-effect modules
// (queue, guard) go through `vi.mock` so the test asserts on call shapes
// instead of dragging Redis/Ollama in.

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
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../queue', () => ({
  redis: {},
  interestsQueue: { add: vi.fn().mockResolvedValue(undefined) },
  guardQueue: {},
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn().mockResolvedValue(
    '{"verdict":"clear_yes","reason":"OK.","confidence":0.9}',
  ),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { ollamaGenerate } from '../../ollama';
import { interestsRouter } from './router';

const app = express();
app.use(express.json());
app.use('/interests', interestsRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
});

const KID_USER_ID = '11111111-1111-7111-8111-111111111111';
const ADULT_USER_ID = '22222222-2222-7222-8222-222222222222';

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(KID_USER_ID, 'Boy1', 'kid', 12, new Date().getUTCFullYear() - 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ADULT_USER_ID, 'Adult1', 'parent', 18, new Date().getUTCFullYear() - 40, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM guard_eval');
  db.exec('DELETE FROM user_interests');
  db.exec('DELETE FROM interests');
  vi.mocked(ollamaGenerate).mockClear();
  vi.mocked(ollamaGenerate).mockResolvedValue(
    '{"verdict":"clear_yes","reason":"OK.","confidence":0.9}',
  );
});

async function post(path: string, body: unknown): Promise<{ status: number; json: <T = unknown>() => T }> {
  const res = await supertest(app)
    .post(path)
    .set('Content-Type', 'application/json')
    .send(body as object);
  return {
    status: res.status,
    json: <T = unknown>() => (res.text ? (JSON.parse(res.text) as T) : (res.body as T)),
  };
}

describe('POST /interests/user-add — kid-interest guard wiring (#110)', () => {
  it('writes a kid_interest guard_eval row with the typed label as subject_text when a kid adds an interest', async () => {
    const res = await post('/interests/user-add', { userId: KID_USER_ID, label: 'Bird Watching' });
    expect(res.status).toBe(200);
    const body = res.json<{ interestId: string; label: string }>();
    expect(body.label).toBe('Bird Watching');

    const evalRow = db
      .prepare(
        'SELECT request_type, subject_text, interest_id, gemma_verdict FROM guard_eval WHERE interest_id = ?',
      )
      .get(body.interestId) as
      | { request_type: string; subject_text: string; interest_id: string; gemma_verdict: string }
      | undefined;

    expect(evalRow).toBeDefined();
    expect(evalRow?.request_type).toBe('kid_interest');
    expect(evalRow?.subject_text).toBe('Bird Watching');
    expect(evalRow?.interest_id).toBe(body.interestId);
    expect(evalRow?.gemma_verdict).toBe('clear_yes');
  });

  it('adds the interest to user_interests regardless of the Gemma verdict (shadow mode)', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '{"verdict":"clear_no","reason":"Inappropriate.","confidence":0.9}',
    );
    const res = await post('/interests/user-add', { userId: KID_USER_ID, label: 'Rocketry' });
    expect(res.status).toBe(200);
    const body = res.json<{ interestId: string }>();

    const userInterest = db
      .prepare('SELECT 1 AS ok FROM user_interests WHERE user_id = ? AND interest_id = ?')
      .get(KID_USER_ID, body.interestId) as { ok: number } | undefined;
    expect(userInterest).toBeDefined();

    const evalRow = db
      .prepare('SELECT gemma_verdict FROM guard_eval WHERE interest_id = ?')
      .get(body.interestId) as { gemma_verdict: string } | undefined;
    expect(evalRow?.gemma_verdict).toBe('clear_no');
  });

  it('still adds the interest when the guard call throws — never blocks the add', async () => {
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));
    const res = await post('/interests/user-add', { userId: KID_USER_ID, label: 'Skateboarding' });
    expect(res.status).toBe(200);
    const body = res.json<{ interestId: string }>();

    const userInterest = db
      .prepare('SELECT 1 AS ok FROM user_interests WHERE user_id = ? AND interest_id = ?')
      .get(KID_USER_ID, body.interestId) as { ok: number } | undefined;
    expect(userInterest).toBeDefined();

    // evaluateKidInterest swallows Ollama errors internally and still writes a
    // guard_eval row tagged uncertain; either way, the add must succeed.
  });

  it('does NOT write a guard_eval row when an adult adds an interest', async () => {
    const res = await post('/interests/user-add', { userId: ADULT_USER_ID, label: 'Investing' });
    expect(res.status).toBe(200);
    const body = res.json<{ interestId: string }>();

    const evalRow = db
      .prepare('SELECT 1 AS ok FROM guard_eval WHERE interest_id = ?')
      .get(body.interestId) as { ok: number } | undefined;
    expect(evalRow).toBeUndefined();

    // The add itself must still have succeeded.
    const userInterest = db
      .prepare('SELECT 1 AS ok FROM user_interests WHERE user_id = ? AND interest_id = ?')
      .get(ADULT_USER_ID, body.interestId) as { ok: number } | undefined;
    expect(userInterest).toBeDefined();

    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });
});
