import express, { NextFunction, Request, Response, Router } from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Enrolment, the credential gate, and the device's own row (ADR-0016).
// In-memory SQLite, the same harness the other DB-touching tests use: the
// migrations run once against `:memory:` and each test starts from clean
// devices and used_tokens tables.
vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../config', () => ({ config: { TOKEN_SECRET: 'a'.repeat(32) } }));

// The real signed tokens, without the rest of the notifications module.
vi.mock('../notifications', async () => await import('../notifications/tokens'));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { generateActionToken } from '../notifications/tokens';
import { devicesRouter } from './router';
import {
  actorOf,
  claimMatchesActor,
  credentialFromHeaders,
  hashCredential,
  identityClaims,
  requireDevice,
  requireParentActor,
  requireParentDevice,
} from './credential';
import { createInvite } from './enrolment';
import { forgetDevice, listPushDevices } from './registry';

const PARENT = '11111111-1111-7111-8111-111111111111';
const KID = '22222222-2222-7222-8222-222222222222';
const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

// A stand-in API behind the real gates: who am I, and a parent-only route.
const probe = Router();
probe.get('/whoami', (req: Request, res: Response) => {
  res.json({ userId: actorOf(req).user_id });
});
probe.post('/whoami', (req: Request, res: Response) => {
  res.json({ userId: actorOf(req).user_id });
});
probe.get('/parent-only', (req: Request, res: Response) => {
  res.json({ userId: requireParentActor(req).user_id });
});

const app = express();
app.use(express.json());
app.use('/devices', devicesRouter);
app.use('/api', requireDevice, probe);
app.use('/parent-api', requireParentDevice, probe);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION_ERROR' ? 400
      : err.code === 'UNAUTHENTICATED' ? 401
      : err.code === 'FORBIDDEN' ? 403
      : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const request = supertest(app);

async function enrol(user: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request
    .post('/devices/enrol')
    .send({ invite: createInvite(user).token, deliver: 'body', ...extra });
  expect(res.status).toBe(200);
  return res.body.credential as string;
}

const bearer = (credential: string) => ({ Authorization: `Bearer ${credential}` });

beforeAll(() => {
  runMigrations();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run(PARENT, 'User1', 'parent', 0, new Date().toISOString());
  insertUser.run(KID, 'Boy1', 'kid', 1, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM devices');
  db.exec('DELETE FROM used_tokens');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enrolment', () => {
  it('redeems an invite into a credential for the invited user', async () => {
    const credential = await enrol(KID);
    const me = await request.get('/devices/me').set(bearer(credential));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ userId: KID, displayName: 'Boy1', role: 'kid' });
  });

  it('accepts a display name when the operator mints the invite', async () => {
    expect(createInvite('boy1').userId).toBe(KID);
  });

  it('sets an HttpOnly cookie and keeps the credential out of the body by default', async () => {
    const res = await request.post('/devices/enrol').send({ invite: createInvite(KID).token });
    expect(res.status).toBe(200);
    expect(res.body.credential).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^eddy_device=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const me = await request.get('/devices/me').set('Cookie', cookie.split(';')[0]!);
    expect(me.body.userId).toBe(KID);
  });

  it('marks the cookie Secure behind the HTTPS proxy', async () => {
    const res = await request
      .post('/devices/enrol')
      .set('X-Forwarded-Proto', 'https')
      .send({ invite: createInvite(KID).token });
    expect(String(res.headers['set-cookie'])).toContain('Secure');
  });

  it('stores only the hash of the credential', async () => {
    const credential = await enrol(KID);
    const rows = db.prepare('SELECT credential_hash FROM devices').all() as Array<{ credential_hash: string }>;
    expect(rows).toEqual([{ credential_hash: hashCredential(credential) }]);
    expect(JSON.stringify(rows)).not.toContain(credential);
  });

  it('refuses the same invite twice', async () => {
    const { token } = createInvite(KID);
    expect((await request.post('/devices/enrol').send({ invite: token })).status).toBe(200);
    const again = await request.post('/devices/enrol').send({ invite: token });
    expect(again.status).toBe(403);
    expect(again.body.message).toMatch(/Ask a parent for a new one/);
  });

  it('refuses an expired invite', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(start);
    const { token } = createInvite(KID);
    vi.setSystemTime(new Date(start.getTime() + 61 * 60_000));
    expect((await request.post('/devices/enrol').send({ invite: token })).status).toBe(403);
  });

  it('refuses a tampered invite, and cannot be pointed at another user', async () => {
    const { token } = createInvite(KID);
    const [payload, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(Buffer.from(payload, 'base64url').toString().replace(KID, PARENT)).toString(
      'base64url'
    );
    expect((await request.post('/devices/enrol').send({ invite: `${forged}.${sig}` })).status).toBe(403);
  });

  it('refuses a notification action token presented as an invite', async () => {
    const actionToken = generateActionToken('approve', PARENT);
    expect((await request.post('/devices/enrol').send({ invite: actionToken })).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });

  it('does not let a userId in the enrolment body pick the user', async () => {
    const res = await request
      .post('/devices/enrol')
      .send({ invite: createInvite(KID).token, userId: PARENT, deliver: 'body' });
    expect(res.body.userId).toBe(KID);
  });

  it('rejects a missing invite and an unknown deviceType', async () => {
    expect((await request.post('/devices/enrol').send({})).status).toBe(400);
    expect(
      (await request.post('/devices/enrol').send({ invite: createInvite(KID).token, deviceType: 'toaster' })).status
    ).toBe(400);
  });
});

describe('the credential gate', () => {
  it('401s with no credential, an unknown one, or a malformed one', async () => {
    expect((await request.get('/api/whoami')).status).toBe(401);
    expect((await request.get('/api/whoami').set(bearer('x'.repeat(43)))).status).toBe(401);
    expect((await request.get('/api/whoami').set(bearer('not a credential'))).status).toBe(401);
    expect((await request.get('/api/whoami').query({ userId: PARENT })).status).toBe(401);
  });

  it('acts as the credential’s owner when the request names nobody', async () => {
    const credential = await enrol(KID);
    const res = await request.get('/api/whoami').set(bearer(credential));
    expect(res.body.userId).toBe(KID);
  });

  it('accepts a claim that agrees with the credential, by id or display name', async () => {
    const credential = await enrol(KID);
    expect((await request.get('/api/whoami').set(bearer(credential)).query({ userId: KID })).status).toBe(200);
    expect((await request.get('/api/whoami').set(bearer(credential)).query({ user: 'boy1' })).status).toBe(200);
  });

  it('403s a kid’s device claiming to be a parent, in the query or the body', async () => {
    const credential = await enrol(KID);
    expect((await request.get('/api/whoami').set(bearer(credential)).query({ userId: PARENT })).status).toBe(403);
    expect(
      (await request.post('/api/whoami').set(bearer(credential)).send({ userId: PARENT })).status
    ).toBe(403);
    expect(
      (await request.get(`/api/whoami?userId=${KID}&userId=${PARENT}`).set(bearer(credential))).status
    ).toBe(403);
  });

  it('stops authenticating once the device is signed out', async () => {
    const credential = await enrol(KID);
    const { body } = await request.get('/devices/me').set(bearer(credential));
    expect((await request.delete(`/devices/${body.deviceId}`).set(bearer(credential))).status).toBe(204);
    expect((await request.get('/api/whoami').set(bearer(credential))).status).toBe(401);
  });
});

describe('the role check', () => {
  it('lets a parent’s device through a parent-only route', async () => {
    const credential = await enrol(PARENT);
    const res = await request.get('/api/parent-only').set(bearer(credential));
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(PARENT);
  });

  it('refuses a kid’s device, whatever userId it sends', async () => {
    const credential = await enrol(KID);
    expect((await request.get('/api/parent-only').set(bearer(credential))).status).toBe(403);
    expect(
      (await request.get('/api/parent-only').set(bearer(credential)).query({ userId: PARENT })).status
    ).toBe(403);
  });

  it('the parent gate refuses a kid and lets a parent name a kid as the subject', async () => {
    const kid = await enrol(KID);
    const parent = await enrol(PARENT);
    expect((await request.get('/parent-api/whoami').set(bearer(kid))).status).toBe(403);
    const res = await request.get('/parent-api/whoami').set(bearer(parent)).query({ user: 'Boy1' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(PARENT);
  });
});

describe('POST /devices (push registration)', () => {
  it('attaches the token to the enrolled device’s own row', async () => {
    const credential = await enrol(KID);
    const res = await request
      .post('/devices')
      .set(bearer(credential))
      .send({ apnsToken: TOKEN, apnsEnvironment: 'sandbox', deviceType: 'tablet' });
    expect(res.status).toBe(200);
    expect(listPushDevices(KID)).toEqual([{ deviceId: res.body.deviceId, apnsToken: TOKEN, apnsEnvironment: 'sandbox' }]);
  });

  it('refuses without a credential', async () => {
    const res = await request
      .post('/devices')
      .send({ userId: KID, apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    expect(res.status).toBe(401);
  });

  it('takes the token over from a pre-enrolment push-only row', async () => {
    db.prepare(
      `INSERT INTO devices (device_id, display_name, owner_user_id, device_type, created_at, apns_token, apns_environment)
       VALUES ('legacy', 'Old row', ?, 'phone', ?, ?, 'production')`
    ).run(KID, new Date().toISOString(), TOKEN);

    const credential = await enrol(KID);
    await request.post('/devices').set(bearer(credential)).send({ apnsToken: TOKEN, apnsEnvironment: 'production' });

    expect(listPushDevices(KID)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM devices WHERE device_id = 'legacy'").get()).toEqual({ n: 0 });
  });

  it('moves a token between enrolled devices without signing the old one out', async () => {
    const first = await enrol(PARENT);
    const second = await enrol(KID);
    await request.post('/devices').set(bearer(first)).send({ apnsToken: TOKEN, apnsEnvironment: 'sandbox' });
    await request.post('/devices').set(bearer(second)).send({ apnsToken: TOKEN, apnsEnvironment: 'sandbox' });

    expect(listPushDevices(PARENT)).toEqual([]);
    expect(listPushDevices(KID)).toHaveLength(1);
    expect((await request.get('/devices/me').set(bearer(first))).status).toBe(200);
  });

  it('rejects a malformed token and an unknown environment', async () => {
    const credential = await enrol(KID);
    const post = (body: object) => request.post('/devices').set(bearer(credential)).send(body);
    expect((await post({ apnsToken: 'nope', apnsEnvironment: 'sandbox' })).status).toBe(400);
    expect((await post({ apnsToken: TOKEN, apnsEnvironment: 'staging' })).status).toBe(400);
  });
});

describe('DELETE /devices/:deviceId', () => {
  it('404s for anyone but the owner, and leaves the device enrolled', async () => {
    const mine = await enrol(PARENT);
    const theirs = await enrol(KID);
    const { body } = await request.get('/devices/me').set(bearer(mine));

    expect((await request.delete(`/devices/${body.deviceId}`).set(bearer(theirs))).status).toBe(404);
    expect((await request.get('/devices/me').set(bearer(mine))).status).toBe(200);
  });

  it('signs the calling device out by /me', async () => {
    const credential = await enrol(KID);
    expect((await request.delete('/devices/me').set(bearer(credential))).status).toBe(204);
    expect((await request.get('/devices/me').set(bearer(credential))).status).toBe(401);
  });

  it('404s for a device that does not exist', async () => {
    const credential = await enrol(PARENT);
    expect((await request.delete('/devices/no-such-device').set(bearer(credential))).status).toBe(404);
  });
});

describe('forgetDevice', () => {
  it('drops the push identity but keeps an enrolled device signed in', async () => {
    const credential = await enrol(KID);
    const { body } = await request
      .post('/devices')
      .set(bearer(credential))
      .send({ apnsToken: OTHER_TOKEN, apnsEnvironment: 'production' });

    forgetDevice(body.deviceId);

    expect(listPushDevices(KID)).toEqual([]);
    expect((await request.get('/devices/me').set(bearer(credential))).status).toBe(200);
  });

  it('removes a push-only row outright', () => {
    db.prepare(
      `INSERT INTO devices (device_id, display_name, owner_user_id, device_type, created_at, apns_token, apns_environment)
       VALUES ('legacy', 'Old row', ?, 'phone', ?, ?, 'production')`
    ).run(KID, new Date().toISOString(), TOKEN);
    forgetDevice('legacy');
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });
});

describe('pure helpers', () => {
  const credential = 'c'.repeat(43);

  it('reads a bearer token before the cookie', () => {
    expect(credentialFromHeaders({ authorization: `Bearer ${credential}` })).toBe(credential);
    expect(credentialFromHeaders({ cookie: `theme=dark; eddy_device=${credential}` })).toBe(credential);
    expect(
      credentialFromHeaders({ authorization: 'Bearer short', cookie: `eddy_device=${credential}` })
    ).toBeNull();
    expect(credentialFromHeaders({ cookie: 'eddy_device=' })).toBeNull();
    expect(credentialFromHeaders({})).toBeNull();
  });

  it('collects every identity claim from the query and the body', () => {
    expect(identityClaims({ userId: ['a', 'b'] }, { user: 'c' })).toEqual(['a', 'b', 'c']);
    expect(identityClaims({}, undefined)).toEqual([]);
  });

  it('matches a claim by id or display name, and nothing else', () => {
    const actor = { user_id: KID, display_name: 'Boy1' };
    expect(claimMatchesActor(KID.toUpperCase(), actor)).toBe(true);
    expect(claimMatchesActor(' boy1 ', actor)).toBe(true);
    expect(claimMatchesActor(PARENT, actor)).toBe(false);
    expect(claimMatchesActor(['x'], actor)).toBe(false);
  });
});
