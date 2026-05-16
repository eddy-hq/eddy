import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import 'express-async-errors';
import request from 'supertest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.exec(`
    CREATE TABLE users (
      user_id      TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role         TEXT NOT NULL,
      age_gate     INTEGER NOT NULL DEFAULT 0,
      birth_year   INTEGER,
      profile      TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT ''
    );
  `);
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { EddyError } from '../../errors';
import { avatarsRouter } from './router';
import { DEFAULT_AVATAR } from './types';
import { getAvatar } from './store';

const USER_ID = '11111111-1111-7111-8111-111111111111';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/avatars', avatarsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof EddyError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
      res.status(status).json({ error: err.code });
      return;
    }
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}

beforeEach(() => {
  db.exec('DELETE FROM users');
  db.prepare(
    `INSERT INTO users (user_id, display_name, role, age_gate, profile, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(USER_ID, 'Boy1', 'kid', 12, '{}', new Date().toISOString());
});

describe('GET /avatars', () => {
  it('returns the default avatar for a user with no saved config', async () => {
    const res = await request(makeApp()).get(`/avatars?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.avatar).toEqual(DEFAULT_AVATAR);
  });

  it('returns the saved avatar', async () => {
    db.prepare('UPDATE users SET profile = ? WHERE user_id = ?').run(
      JSON.stringify({
        avatar: { ...DEFAULT_AVATAR, hairColour: 'pink', accessory: 'glasses' },
      }),
      USER_ID,
    );
    const res = await request(makeApp()).get(`/avatars?userId=${USER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.avatar.hairColour).toBe('pink');
    expect(res.body.avatar.accessory).toBe('glasses');
  });

  it('404s for an unknown user', async () => {
    const res = await request(makeApp()).get('/avatars?userId=99999999-9999-7999-8999-999999999999');
    expect(res.status).toBe(404);
  });
});

describe('PUT /avatars', () => {
  it('saves an avatar and returns it', async () => {
    const next = { ...DEFAULT_AVATAR, hairStyle: 'mohawk', shirt: 'purple' };
    const res = await request(makeApp())
      .put('/avatars')
      .send({ userId: USER_ID, avatar: next });
    expect(res.status).toBe(200);
    expect(res.body.avatar.hairStyle).toBe('mohawk');
    expect(res.body.avatar.shirt).toBe('purple');
    expect(getAvatar(USER_ID).hairStyle).toBe('mohawk');
  });

  it('coerces unknown fields back to defaults rather than rejecting', async () => {
    const res = await request(makeApp())
      .put('/avatars')
      .send({
        userId: USER_ID,
        avatar: { ...DEFAULT_AVATAR, hairStyle: 'mullet-2026', skin: 'rainbow' },
      });
    expect(res.status).toBe(200);
    expect(res.body.avatar.hairStyle).toBe(DEFAULT_AVATAR.hairStyle);
    expect(res.body.avatar.skin).toBe(DEFAULT_AVATAR.skin);
  });

  it('preserves other profile keys', async () => {
    db.prepare('UPDATE users SET profile = ? WHERE user_id = ?').run(
      JSON.stringify({ favouriteColour: 'green' }),
      USER_ID,
    );
    await request(makeApp())
      .put('/avatars')
      .send({ userId: USER_ID, avatar: { ...DEFAULT_AVATAR, accessory: 'cap' } });
    const row = db.prepare('SELECT profile FROM users WHERE user_id = ?').get(USER_ID) as { profile: string };
    const profile = JSON.parse(row.profile) as { favouriteColour: string; avatar: { accessory: string } };
    expect(profile.favouriteColour).toBe('green');
    expect(profile.avatar.accessory).toBe('cap');
  });
});
