import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Parent picks (#217) end to end through the requests router: real state
// machine and migrations on an in-memory DB, with fake ports so no queue,
// notification or person capture runs. Fixtures are synthetic.

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
  config: { PORT: 3737, TAILSCALE_IP: '127.0.0.1' },
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), del: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: vi.fn() },
  deleteQueue: { add: vi.fn() },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../people/registry', () => ({
  ensurePersonForChannel: vi.fn(),
  applyChannelInfoToPerson: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { createRequestsState, type Ports } from './state';
import { registerDefaultRequestsState } from './state-default';
import { PARENT_PICK_BLOCKED_MESSAGE, PARENT_PICK_NOT_LIVE_MESSAGE } from './parent-pick';
import { requestsRouter } from './index';

const app = express();
app.use(express.json());
app.use('/requests', requestsRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION_ERROR' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const PARENT_ID = '99999999-9999-7999-8999-999999999999';
const KID_1 = '11111111-1111-7111-8111-111111111111';
const KID_2 = '22222222-2222-7222-8222-222222222222';
const PARENT_REQ = 'req-parent-1';
const YT_ID = 'pickvideo01';
const FILE = `/mnt/ssd/eddy/videos/${YT_ID}.mp4`;
const CHANNEL_ID = 'UCplaceholderchannel0001';
const BLOCKED_CHANNEL_ID = 'UCblockedblockedblocked0';

let ports: Ports;

function makePorts(): Ports {
  return {
    notifyVideoReady: vi.fn().mockResolvedValue(undefined),
    enqueueDownload: vi.fn().mockResolvedValue(undefined),
    enqueueDelete: vi.fn().mockResolvedValue(undefined),
    cancelDownloadJob: vi.fn().mockResolvedValue(undefined),
    redisDel: vi.fn().mockResolvedValue(1),
    ensurePerson: vi.fn().mockReturnValue({ personId: 'person-1', created: false }),
    applyChannelInfo: vi.fn().mockResolvedValue(undefined),
  };
}

function insertRow(opts: {
  requestId: string;
  userId: string;
  status: string;
  source?: string;
  channelId?: string;
  fileState?: string;
  filePath?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, youtube_channel_id, title, channel,
       status, file_path, file_state, nginx_url, requested_at, added_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Placeholder title', 'Placeholder channel', ?, ?, ?, ?, ?, ?)
  `).run(
    opts.requestId, opts.userId, opts.source ?? 'share_sheet',
    `https://www.youtube.com/watch?v=${YT_ID}`, YT_ID, opts.channelId ?? CHANNEL_ID,
    opts.status, opts.filePath === undefined ? FILE : opts.filePath, opts.fileState ?? 'live',
    `http://mediaserver/videos/${YT_ID}.mp4`, now, now,
  );
}

function send(requestId: string, userId: string, kidIds: string[]) {
  return supertest(app).post(`/requests/${requestId}/send`).send({ userId, kidIds });
}

function kidRows(): Array<{ user_id: string; source: string; sent_by: string | null; status: string; file_path: string | null }> {
  return db.prepare(
    `SELECT user_id, source, sent_by, status, file_path FROM requests
      WHERE user_id != ? ORDER BY user_id`,
  ).all(PARENT_ID) as Array<{ user_id: string; source: string; sent_by: string | null; status: string; file_path: string | null }>;
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertUser.run(PARENT_ID, 'Parent1', 'parent', 0, now);
  insertUser.run(KID_1, 'Boy1', 'kid', 1, now);
  insertUser.run(KID_2, 'Boy2', 'kid', 1, now);
  db.prepare('INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)')
    .run(BLOCKED_CHANNEL_ID, 'Placeholder blocked channel', PARENT_ID, now);
});

beforeEach(() => {
  db.exec('DELETE FROM guard_eval');
  db.exec('DELETE FROM requests');
  ports = makePorts();
  registerDefaultRequestsState(createRequestsState({ ports }));
  insertRow({ requestId: PARENT_REQ, userId: PARENT_ID, status: 'watched' });
});

describe('POST /requests/:id/send', () => {
  it('"Both" creates one ready parent pick per kid, sharing the parent\'s file', async () => {
    const res = await send(PARENT_REQ, PARENT_ID, [KID_1, KID_2]);

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['sent', 'sent']);
    expect(kidRows()).toEqual([
      { user_id: KID_1, source: 'parent_pick', sent_by: PARENT_ID, status: 'ready', file_path: FILE },
      { user_id: KID_2, source: 'parent_pick', sent_by: PARENT_ID, status: 'ready', file_path: FILE },
    ]);
    expect(ports.notifyVideoReady).toHaveBeenCalledTimes(2);
  });

  it('skips the guard: nothing is downloaded and no guard verdict or eval is recorded', async () => {
    await send(PARENT_REQ, PARENT_ID, [KID_1]);

    expect(ports.enqueueDownload).not.toHaveBeenCalled();
    const row = db.prepare(`SELECT guard_verdict FROM requests WHERE user_id = ?`).get(KID_1) as { guard_verdict: string | null };
    expect(row.guard_verdict).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM guard_eval').get() as { n: number }).n).toBe(0);
  });

  it('dedups: a kid who already has the video live gets no second card', async () => {
    insertRow({ requestId: 'req-kid1-own', userId: KID_1, status: 'ready' });

    const res = await send(PARENT_REQ, PARENT_ID, [KID_1, KID_2]);

    expect(res.body.results).toEqual([
      { kidId: KID_1, displayName: 'Boy1', outcome: 'already', requestId: 'req-kid1-own' },
      expect.objectContaining({ kidId: KID_2, outcome: 'sent' }),
    ]);
    const kid1 = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE user_id = ?').get(KID_1) as { n: number };
    expect(kid1.n).toBe(1);
  });

  it('sending twice does not duplicate the card', async () => {
    await send(PARENT_REQ, PARENT_ID, [KID_1]);
    const res = await send(PARENT_REQ, PARENT_ID, [KID_1]);

    expect(res.body.results[0].outcome).toBe('already');
    expect(kidRows()).toHaveLength(1);
    expect(ports.notifyVideoReady).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'guard_pending', source: 'recommended' },
    { status: 'guard_review', source: 'recommended' },
    // A fresh follow upload is hidden from the feed until it arrives ready.
    { status: 'downloading', source: 'channel_subscription' },
    { status: 'pending', source: 'channel_subscription' },
    { status: 'failed', source: 'share_sheet' },
    { status: 'rejected', source: 'share_sheet' },
  ])(
    'turns an undelivered copy ($status $source) into the parent pick, with no second card',
    async ({ status, source }) => {
      insertRow({ requestId: 'req-kid1-held', userId: KID_1, status, source, filePath: null });

      const res = await send(PARENT_REQ, PARENT_ID, [KID_1]);

      expect(res.body.results[0]).toMatchObject({ outcome: 'sent', requestId: 'req-kid1-held' });
      expect(kidRows()).toEqual([
        { user_id: KID_1, source: 'parent_pick', sent_by: PARENT_ID, status: 'ready', file_path: FILE },
      ]);
      expect(ports.notifyVideoReady).toHaveBeenCalledTimes(1);
      expect(ports.enqueueDownload).not.toHaveBeenCalled();
    },
  );

  it('brings a request held since long ago into Today\'s stream', async () => {
    insertRow({ requestId: 'req-kid1-old', userId: KID_1, status: 'guard_pending', source: 'recommended' });
    db.prepare(`UPDATE requests SET added_at = '2026-01-01T00:00:00.000Z', requested_at = '2026-01-01T00:00:00.000Z'
                 WHERE request_id = 'req-kid1-old'`).run();

    await send(PARENT_REQ, PARENT_ID, [KID_1]);

    const feed = await supertest(app).get(`/requests/feed?userId=${KID_1}`);
    const today = feed.body.days.find((d: { label: string }) => d.label === 'Today');
    const todayCards = today.sections.find((s: { id: string }) => s.id === 'today').cards;
    expect(todayCards.map((c: { request_id: string }) => c.request_id)).toEqual(['req-kid1-old']);
  });

  it('reports a dismissed copy as already in their feed', async () => {
    insertRow({ requestId: 'req-kid1-dismissed', userId: KID_1, status: 'dismissed' });

    const res = await send(PARENT_REQ, PARENT_ID, [KID_1]);

    expect(res.body.results[0]).toMatchObject({ outcome: 'already', requestId: 'req-kid1-dismissed' });
  });

  it('a kid\'s deleted copy does not block a fresh send', async () => {
    insertRow({ requestId: 'req-kid1-gone', userId: KID_1, status: 'deleted', fileState: 'gone' });

    const res = await send(PARENT_REQ, PARENT_ID, [KID_1]);

    expect(res.body.results[0].outcome).toBe('sent');
  });

  it('refuses a blocked channel with a clear message, writing nothing', async () => {
    db.exec('DELETE FROM requests');
    insertRow({ requestId: PARENT_REQ, userId: PARENT_ID, status: 'ready', channelId: BLOCKED_CHANNEL_ID });

    const res = await send(PARENT_REQ, PARENT_ID, [KID_1, KID_2]);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(PARENT_PICK_BLOCKED_MESSAGE);
    expect(kidRows()).toHaveLength(0);
    expect(ports.notifyVideoReady).not.toHaveBeenCalled();
  });

  it('refuses a video whose file is no longer on disk', async () => {
    db.exec('DELETE FROM requests');
    insertRow({ requestId: PARENT_REQ, userId: PARENT_ID, status: 'watched', fileState: 'recycled', filePath: null });

    const res = await send(PARENT_REQ, PARENT_ID, [KID_1]);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(PARENT_PICK_NOT_LIVE_MESSAGE);
    expect(kidRows()).toHaveLength(0);
  });

  it('refuses a kid as the sender', async () => {
    insertRow({ requestId: 'req-kid1-own', userId: KID_1, status: 'ready' });

    const res = await send('req-kid1-own', KID_1, [KID_2]);

    expect(res.status).toBe(403);
    expect(kidRows().filter((r) => r.user_id === KID_2)).toHaveLength(0);
  });

  it('refuses a parent as the target', async () => {
    const res = await send(PARENT_REQ, PARENT_ID, [PARENT_ID]);

    expect(res.status).toBe(403);
  });

  it('refuses a video outside the parent\'s own library', async () => {
    insertRow({ requestId: 'req-kid1-own', userId: KID_1, status: 'ready' });

    const res = await send('req-kid1-own', PARENT_ID, [KID_2]);

    expect(res.status).toBe(404);
  });
});

describe('parent picks on the kid\'s feed', () => {
  it('sit in the Today stream, not "You asked", with the sender\'s name', async () => {
    await send(PARENT_REQ, PARENT_ID, [KID_1]);

    const res = await supertest(app).get(`/requests/feed?userId=${KID_1}`);
    const today = res.body.days[0];
    const sections = Object.fromEntries(
      today.sections.map((s: { id: string; cards: Array<{ source: string; sent_by_name: string | null }> }) => [s.id, s.cards]),
    );
    expect(sections['requests']).toEqual([]);
    expect(sections['today']).toEqual([expect.objectContaining({ source: 'parent_pick', sent_by_name: 'Parent1' })]);
  });

  it('carry the sender\'s name on the detail read', async () => {
    const sent = await send(PARENT_REQ, PARENT_ID, [KID_1]);

    const res = await supertest(app).get(`/requests/${sent.body.results[0].requestId}`);
    expect(res.body).toMatchObject({ source: 'parent_pick', sentByName: 'Parent1' });
  });
});

describe('GET /requests/send-targets', () => {
  it('lists every kid for a parent', async () => {
    const res = await supertest(app).get(`/requests/send-targets?userId=${PARENT_ID}`);

    expect(res.body.kids).toEqual([
      { userId: KID_1, displayName: 'Boy1' },
      { userId: KID_2, displayName: 'Boy2' },
    ]);
  });

  it('is empty for a kid', async () => {
    const res = await supertest(app).get(`/requests/send-targets?userId=${KID_1}`);

    expect(res.status).toBe(200);
    expect(res.body.kids).toEqual([]);
  });
});
