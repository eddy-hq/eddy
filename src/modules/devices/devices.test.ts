import express, { NextFunction, Request, Response } from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// In-memory SQLite, the same harness the other DB-touching tests use: the
// migrations run once against `:memory:` and each test starts from a clean
// devices table.
vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { devicesRouter } from './router';
import { listPushDevices, forgetDevice } from './registry';

const OWNER = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';
const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

const app = express();
app.use(express.json());
app.use('/devices', devicesRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.code });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const request = supertest(app);

function register(body: Record<string, unknown>) {
  return request.post('/devices').send(body);
}

beforeAll(() => {
  runMigrations();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run(OWNER, 'User1', 'parent', 0, new Date().toISOString());
  insertUser.run(OTHER, 'User2', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM devices');
});

describe('POST /devices', () => {
  it('registers a device and returns its id', async () => {
    const res = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    expect(res.status).toBe(200);
    expect(typeof res.body.deviceId).toBe('string');

    expect(listPushDevices(OWNER)).toEqual([
      { deviceId: res.body.deviceId, apnsToken: TOKEN, apnsEnvironment: 'sandbox' },
    ]);
  });

  it('upserts rather than duplicating when the same device re-registers', async () => {
    const first = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    const second = await register({
      userId: OWNER,
      deviceId: first.body.deviceId,
      apnsToken: OTHER_TOKEN,
      apnsEnvironment: 'production',
    });

    expect(second.body.deviceId).toBe(first.body.deviceId);
    expect(listPushDevices(OWNER)).toEqual([
      { deviceId: first.body.deviceId, apnsToken: OTHER_TOKEN, apnsEnvironment: 'production' },
    ]);
  });

  it('recognises a returning device by its token when the app has no id yet', async () => {
    const first = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    const second = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });

    expect(second.body.deviceId).toBe(first.body.deviceId);
    expect(listPushDevices(OWNER)).toHaveLength(1);
  });

  it('moves a token to its new owner instead of leaving two rows holding it', async () => {
    await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    const handedDown = await register({
      userId: OTHER,
      apnsToken: TOKEN,
      apnsEnvironment: 'sandbox',
    });

    expect(handedDown.status).toBe(200);
    expect(listPushDevices(OWNER)).toEqual([]);
    expect(listPushDevices(OTHER)).toHaveLength(1);
  });

  it('will not let one user re-register another user’s device id', async () => {
    const mine = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    const res = await register({
      userId: OTHER,
      deviceId: mine.body.deviceId,
      apnsToken: OTHER_TOKEN,
      apnsEnvironment: 'sandbox',
    });

    expect(res.status).toBe(404);
    expect(listPushDevices(OWNER)).toHaveLength(1);
    expect(listPushDevices(OTHER)).toEqual([]);
  });

  it('rejects a malformed token and an unknown environment', async () => {
    expect((await register({ userId: OWNER, apnsToken: 'nope', apnsEnvironment: 'sandbox' })).status).toBe(400);
    expect((await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'staging' })).status).toBe(400);
  });

  it('rejects a registration with no user', async () => {
    expect((await register({ apnsToken: TOKEN, apnsEnvironment: 'sandbox' })).status).toBe(400);
  });
});

describe('DELETE /devices/:deviceId', () => {
  it('lets the owner sign the device out', async () => {
    const { body } = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    const res = await request.delete(`/devices/${body.deviceId}`).query({ userId: OWNER });

    expect(res.status).toBe(204);
    expect(listPushDevices(OWNER)).toEqual([]);
  });

  it('404s for anyone but the owner, and leaves the device registered', async () => {
    const { body } = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    const res = await request.delete(`/devices/${body.deviceId}`).query({ userId: OTHER });

    expect(res.status).toBe(404);
    expect(listPushDevices(OWNER)).toHaveLength(1);
  });

  it('404s for a device that does not exist', async () => {
    const res = await request.delete('/devices/no-such-device').query({ userId: OWNER });
    expect(res.status).toBe(404);
  });
});

describe('listPushDevices', () => {
  it('returns only the asking user’s devices', async () => {
    await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    await register({ userId: OTHER, apnsToken: OTHER_TOKEN, apnsEnvironment: 'production' });

    expect(listPushDevices(OWNER)).toHaveLength(1);
    expect(listPushDevices(OWNER)[0]?.apnsToken).toBe(TOKEN);
  });

  it('skips a device row with no push identity', async () => {
    db.prepare(
      `INSERT INTO devices (device_id, display_name, owner_user_id, device_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('legacy-device', 'An old row', OWNER, 'tablet', new Date().toISOString());

    expect(listPushDevices(OWNER)).toEqual([]);
  });

  it('forgetDevice removes the row the sender was pushing to', async () => {
    const { body } = await register({ userId: OWNER, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    forgetDevice(body.deviceId);
    expect(listPushDevices(OWNER)).toEqual([]);
  });
});
