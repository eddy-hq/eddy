import express, { type Request as ExpressRequest } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Kid requests from a Blocked channel, through the worker's signed
// /channel-check call and the kid's status poll. Real state machine and
// migrations on an in-memory DB; Ollama, queues, notifications and person
// capture are mocked. Fixtures are synthetic.

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
  config: {
    INTERNAL_HMAC_SECRET: 'test-secret',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), del: vi.fn(), set: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: vi.fn().mockResolvedValue(undefined) },
  deleteQueue: { add: vi.fn().mockResolvedValue(undefined) },
  guardQueue: { add: vi.fn() },
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn() }),
  parseRelayPayload: vi.fn(),
}));

vi.mock('../people/registry', () => ({
  ensurePersonForChannel: vi.fn().mockReturnValue({ personId: 'person-1', created: false }),
  applyChannelInfoToPerson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../watchdog', () => ({ checkStuckDownloads: vi.fn() }));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { ollamaGenerate } from '../../ollama';
import { sign } from '../../signed-channel';
import { internalRouter } from '../internal';
import { BLOCKED_CHANNEL_REASON } from '../blocked-channels';
import { requestsRouter } from './index';

const app = express();
app.use(express.json({
  verify: (req: ExpressRequest & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use('/internal', internalRouter);
app.use('/requests', requestsRouter);

const KID_ID = '11111111-1111-7111-8111-111111111111';
const PARENT_ID = '22222222-2222-7222-8222-222222222222';
const BLOCKED_ID = 'UCblockedblockedblocked0';
const OTHER_ID = 'UCotherotherotherother00';

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run(KID_ID, 'Boy1', 'kid', 1, 2013, now);
  insertUser.run(PARENT_ID, 'Parent', 'parent', 0, null, now);
  db.prepare('INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)')
    .run(BLOCKED_ID, 'Placeholder blocked channel', PARENT_ID, now);
});

beforeEach(() => {
  db.exec('DELETE FROM guard_eval');
  db.exec('DELETE FROM requests');
  vi.mocked(ollamaGenerate).mockReset();
});

function seedShareSheetRequest(requestId: string, userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, status, decided_by, decided_at, requested_at, added_at)
     VALUES (?, ?, 'share_sheet', ?, ?, 'downloading', 'auto', ?, ?, ?)`,
  ).run(requestId, userId, `https://www.youtube.com/watch?v=${requestId}`, requestId, now, now, now);
}

async function channelCheck(requestId: string, youtubeChannelId: string | null, channel = 'Placeholder channel') {
  const body = JSON.stringify({ requestId, youtubeChannelId, channel });
  return supertest(app)
    .post(`/internal/requests/${requestId}/channel-check`)
    .set('content-type', 'application/json')
    .set('x-eddy-signature', sign(body))
    .send(body);
}

function row(requestId: string) {
  return db.prepare('SELECT status, rejection_reason, youtube_channel_id FROM requests WHERE request_id = ?')
    .get(requestId) as { status: string; rejection_reason: string | null; youtube_channel_id: string | null };
}

describe('kid request from a blocked channel', () => {
  it('is rejected with a kid-facing reason before the guard runs', async () => {
    seedShareSheetRequest('kid-blocked', KID_ID);

    const res = await channelCheck('kid-blocked', BLOCKED_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blocked: true, reason: BLOCKED_CHANNEL_REASON, rejected: true });
    expect(row('kid-blocked')).toEqual({
      status: 'rejected', rejection_reason: BLOCKED_CHANNEL_REASON, youtube_channel_id: BLOCKED_ID,
    });
    // The guard never ran: no model call, no verdict row.
    expect(ollamaGenerate).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM guard_eval').get()).toEqual({ n: 0 });
  });

  it('shows the kid the reason on the status poll, as an ordinary (appealable) rejection', async () => {
    seedShareSheetRequest('kid-poll', KID_ID);
    await channelCheck('kid-poll', BLOCKED_ID);

    const res = await supertest(app).get('/requests/kid-poll');

    expect(res.status).toBe(200);
    // 'rejected' is the status the share-sheet landing renders with the
    // "ask a grown-up" Appeal copy under the reason.
    expect(res.body).toMatchObject({ status: 'rejected', rejectionReason: BLOCKED_CHANNEL_REASON });
  });

  it('matches on the display name when the metadata has no channel id', async () => {
    seedShareSheetRequest('kid-nameonly', KID_ID);
    const res = await channelCheck('kid-nameonly', null, 'Placeholder blocked channel');
    expect(res.body).toMatchObject({ blocked: true });
    expect(row('kid-nameonly').status).toBe('rejected');
  });

  it('lets a kid request from another channel through', async () => {
    seedShareSheetRequest('kid-ok', KID_ID);
    const res = await channelCheck('kid-ok', OTHER_ID);
    expect(res.body).toEqual({ blocked: false });
    expect(row('kid-ok').status).toBe('downloading');
  });

  it("does not touch an adult's request", async () => {
    seedShareSheetRequest('adult-req', PARENT_ID);
    const res = await channelCheck('adult-req', BLOCKED_ID);
    expect(res.body).toEqual({ blocked: false });
    expect(row('adult-req')).toMatchObject({ status: 'downloading', rejection_reason: null });
  });

  it('refuses an unsigned call', async () => {
    seedShareSheetRequest('kid-unsigned', KID_ID);
    const res = await supertest(app)
      .post('/internal/requests/kid-unsigned/channel-check')
      .send({ requestId: 'kid-unsigned', youtubeChannelId: BLOCKED_ID, channel: null });
    expect(res.status).toBe(401);
    expect(row('kid-unsigned').status).toBe('downloading');
  });
});
