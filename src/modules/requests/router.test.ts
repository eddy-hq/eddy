import { Readable } from 'node:stream';
import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks ────────────────────────────────────────────────────────────
//
// Same harness shape as state.test.ts: the `:memory:` DB stays a real fixture
// so the SQL the router runs is the real SQL, and every side-effect dependency
// (queue, notifications, state machine) goes through `vi.mock` so the test
// asserts on call shapes instead of dragging Redis/ntfy/BullMQ in.

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
    PORT: 3737,
    TAILSCALE_IP: '127.0.0.1',
  },
}));

vi.mock('../../queue', () => ({
  redis: { get: vi.fn(), del: vi.fn() },
  downloadQueue: { getJob: vi.fn() },
  deleteQueue: { add: vi.fn() },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
}));

const notifyMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: notifyMock }),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

// The state machine itself is exercised in state.test.ts; here we only care
// that the router invokes it with the right event shape and threads through
// its result. Default behaviour matches a successful transition; individual
// tests override per-call via mockReturnValueOnce.
const applyMock = vi.fn();
vi.mock('./state-default', () => ({
  getRequestsState: () => ({ apply: applyMock }),
  registerDefaultRequestsState: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import {
  requestsRouter,
  readRecentRejectedRequestsForAdmin,
} from './index';

// ─── Express harness ────────────────────────────────────────────────────────
//
// Minimal mount: same body parser, same error-to-status mapping the real
// server uses (server.ts:130-140), so ValidationError lands as 400 and
// NotFoundError as 404 under test. We listen on an ephemeral port on the
// loopback interface and drive the app with the built-in `fetch`, which is
// the supertest happy-path without the dep.

const app = express();
app.use(express.json());
app.use('/requests', requestsRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
});

interface RouterResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: <T = unknown>() => T;
}

// In-process test client — never opens a socket. Express's `app.handle` is
// happy to take any (req, res) pair that quacks like Node's http types, so
// we hand it a `Readable` masquerading as IncomingMessage (just needs
// `method` / `url` / `headers` plus a stream of body bytes) and a minimal
// fake ServerResponse that captures status / headers / body and resolves a
// "finished" promise on `end()`. Express's `res.json()`, `res.send()`,
// `res.status()` and `res.set()` all reduce to `setHeader` / `statusCode` /
// `end()`, which is exactly the surface we implement.
//
// This avoids `listen()` entirely so the suite stays runnable in
// socket-restricted review environments.
async function request(
  method: string,
  path: string,
  init: { body?: unknown } = {},
): Promise<RouterResponse> {
  const bodyStr = init.body === undefined ? null : JSON.stringify(init.body);
  const bodyBuf = bodyStr === null ? null : Buffer.from(bodyStr, 'utf8');

  const reqHeaders: Record<string, string> = { host: '127.0.0.1' };
  if (bodyBuf) {
    reqHeaders['content-type'] = 'application/json';
    reqHeaders['content-length'] = String(bodyBuf.byteLength);
  }
  const req = Readable.from(bodyBuf ? [bodyBuf] : []) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method.toUpperCase();
  req.url = path;
  req.headers = reqHeaders;

  let statusCode = 200;
  let bodyOut = '';
  const resHeaders: Record<string, string | number | string[]> = {};
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let finishedResolve!: () => void;
  const finished = new Promise<void>((resolve) => { finishedResolve = resolve; });

  // The minimal subset of `http.ServerResponse` that Express's response
  // helpers (`res.status`, `res.json`, `res.send`, `res.set`, `res.end`)
  // ultimately call. Anything extra would be ignored by them anyway.
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(k: string, v: string | number | string[]) {
      resHeaders[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return resHeaders[k.toLowerCase()];
    },
    getHeaders() {
      return { ...resHeaders };
    },
    removeHeader(k: string) {
      delete resHeaders[k.toLowerCase()];
    },
    hasHeader(k: string) {
      return Object.prototype.hasOwnProperty.call(resHeaders, k.toLowerCase());
    },
    write(chunk: Buffer | string) {
      bodyOut += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) this.write(chunk);
      this.headersSent = true;
      this.writableEnded = true;
      statusCode = this.statusCode;
      finishedResolve();
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return this;
    },
    once(event: string, cb: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]): void => {
        cb(...args);
        const list = listeners[event];
        if (list) listeners[event] = list.filter((f) => f !== wrapped);
      };
      return this.on(event, wrapped);
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners[event] ?? []) cb(...args);
      return true;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).handle(req, res, (err: unknown) => {
    if (err && !res.writableEnded) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'UNHANDLED', message: String(err) }));
    }
  });

  await finished;

  const lowered: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(resHeaders)) {
    lowered[k] = typeof v === 'number' ? String(v) : v;
  }
  return {
    status: statusCode,
    headers: lowered,
    body: bodyOut,
    json: <T = unknown>() => JSON.parse(bodyOut) as T,
  };
}

const USER_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-7222-8222-222222222222';

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(OTHER_USER_ID, 'Boy2', 'kid', 10, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  notifyMock.mockClear();
  applyMock.mockReset();
  // Default: every apply call succeeds and settles immediately. Individual
  // tests that care about a specific event shape inspect applyMock directly.
  applyMock.mockReturnValue({
    result: { transitioned: true, userId: USER_ID },
    settled: Promise.resolve(),
  });
});

function insertRequestRow(opts: {
  request_id: string;
  status: string;
  source?: string;
  user_id?: string;
  youtube_id?: string | null;
  url?: string;
  title?: string | null;
  added_at?: string;
  requested_at?: string;
  rejection_reason?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, title, status,
        rejection_reason, requested_at, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.request_id,
    opts.user_id ?? USER_ID,
    opts.source ?? 'share_sheet',
    opts.url ?? 'https://www.youtube.com/watch?v=' + opts.request_id,
    opts.youtube_id ?? null,
    opts.title ?? null,
    opts.status,
    opts.rejection_reason ?? null,
    opts.requested_at ?? now,
    opts.added_at ?? now,
  );
}

// ─── Existing admin-pipeline coverage (kept verbatim) ────────────────────────

describe('requests admin pipeline recency window', () => {
  it('excludes a same-cutoff-day rejected request earlier than the cutoff time', () => {
    const cutoff = db.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours') AS cutoff",
    ).get() as { cutoff: string };
    const requestedAt = new Date(new Date(cutoff.cutoff).getTime() - 60_000).toISOString();
    expect(requestedAt.slice(0, 10)).toBe(cutoff.cutoff.slice(0, 10));

    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, status, rejection_reason, requested_at, added_at)
      VALUES (?, ?, 'share_sheet', ?, 'rejected', ?, ?, ?)
    `).run(
      'request-1',
      USER_ID,
      'https://www.youtube.com/watch?v=request-1',
      'Not suitable',
      requestedAt,
      requestedAt,
    );

    expect(readRecentRejectedRequestsForAdmin()).toEqual([]);
  });
});

// ─── POST /requests — share-sheet entry point ────────────────────────────────

describe('POST /requests', () => {
  it('extracts the first http URL from share-sheet text and passes it through to apply', async () => {
    const shareText = 'Source: YouTube\nhttps://www.youtube.com/watch?v=abc12345xyz';

    const resp = await request('POST', '/requests', {
      body: { url: shareText, user: 'Boy1' },
    });

    expect(resp.status).toBe(202);
    expect(applyMock).toHaveBeenCalledTimes(1);
    const event = applyMock.mock.calls[0]![0];
    expect(event.kind).toBe('create_share_sheet');
    expect(event.input.url).toBe('https://www.youtube.com/watch?v=abc12345xyz');
    expect(event.input.youtubeId).toBe('abc12345xyz');
    expect(event.input.userId).toBe(USER_ID);
  });

  it.each([
    ['https://www.youtube.com/watch?v=abc12345xyz', 'abc12345xyz'],
    ['https://m.youtube.com/watch?v=mob12345xyz', 'mob12345xyz'],
    ['https://youtube.com/shorts/short1234ab', 'short1234ab'],
    ['https://www.youtube.com/live/livestream1', 'livestream1'],
    ['https://youtu.be/shortidab12', 'shortidab12'],
  ])('accepts %s and extracts youtube id %s', async (url, expectedId) => {
    const resp = await request('POST', '/requests', {
      body: { url, user: 'Boy1' },
    });

    expect(resp.status).toBe(202);
    expect(applyMock).toHaveBeenCalledTimes(1);
    const event = applyMock.mock.calls[0]![0];
    expect(event.input.url).toBe(url);
    expect(event.input.youtubeId).toBe(expectedId);
  });

  it('rejects a non-YouTube URL with a 400 ValidationError', async () => {
    const resp = await request('POST', '/requests', {
      body: { url: 'https://example.com/not-youtube', user: 'Boy1' },
    });

    expect(resp.status).toBe(400);
    expect(resp.json<{ error: string }>().error).toBe('VALIDATION_ERROR');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when url is missing', async () => {
    const resp = await request('POST', '/requests', { body: { user: 'Boy1' } });

    expect(resp.status).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when neither userId nor user is provided', async () => {
    const resp = await request('POST', '/requests', {
      body: { url: 'https://www.youtube.com/watch?v=abc12345xyz' },
    });

    expect(resp.status).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('resolves a user by display name passed as `user`', async () => {
    const resp = await request('POST', '/requests', {
      body: { url: 'https://www.youtube.com/watch?v=byname12345', user: 'Boy1' },
    });

    expect(resp.status).toBe(202);
    const event = applyMock.mock.calls[0]![0];
    expect(event.input.userId).toBe(USER_ID);
  });

  it('resolves a user by UUID passed as `userId`', async () => {
    const resp = await request('POST', '/requests', {
      body: { url: 'https://www.youtube.com/watch?v=byuuid12345', userId: USER_ID },
    });

    expect(resp.status).toBe(202);
    const event = applyMock.mock.calls[0]![0];
    expect(event.input.userId).toBe(USER_ID);
  });

  it('dedups against a ready duplicate, returns the existing requestId, and re-fires the video_ready notification', async () => {
    const youtubeId = 'dedupready1';
    insertRequestRow({
      request_id: 'existing-ready',
      status: 'ready',
      youtube_id: youtubeId,
      title: 'Existing title',
    });

    const resp = await request('POST', '/requests', {
      body: { url: `https://www.youtube.com/watch?v=${youtubeId}`, user: 'Boy1' },
    });

    expect(resp.status).toBe(202);
    const body = resp.json<{ requestId: string; status: string }>();
    expect(body.requestId).toBe('existing-ready');
    expect(body.status).toBe('ready');
    // Dedup short-circuits before create_share_sheet would fire.
    expect(applyMock).not.toHaveBeenCalled();

    // The re-notify is deliberate UX: easy to delete by accident, so we always
    // re-fire video_ready on a ready-dedup. The router schedules the notify
    // call with `void`-style fire-and-forget, so the microtask queue may not
    // have drained by the time `res.end()` returns. Flush before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [event, userIdArg] = notifyMock.mock.calls[0]!;
    expect(event).toEqual({
      kind: 'video_ready',
      requestId: 'existing-ready',
      title: 'Existing title',
    });
    expect(userIdArg).toBe(USER_ID);
  });

  it('dedups against a non-ready active duplicate, returns the existing requestId, and does NOT re-fire the notification', async () => {
    const youtubeId = 'dedupbusy01';
    insertRequestRow({
      request_id: 'existing-downloading',
      status: 'downloading',
      youtube_id: youtubeId,
    });

    const resp = await request('POST', '/requests', {
      body: { url: `https://www.youtube.com/watch?v=${youtubeId}`, user: 'Boy1' },
    });

    expect(resp.status).toBe(202);
    const body = resp.json<{ requestId: string; status: string }>();
    expect(body.requestId).toBe('existing-downloading');
    expect(body.status).toBe('downloading');
    expect(applyMock).not.toHaveBeenCalled();

    // Even after flushing the microtask queue, notify must not fire for a
    // non-ready dedup — only the `ready` branch re-notifies.
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('happy path: no duplicate exists → applies create_share_sheet and responds 202 with status downloading', async () => {
    const resp = await request('POST', '/requests', {
      body: { url: 'https://www.youtube.com/watch?v=happy123abc', user: 'Boy1' },
    });

    expect(resp.status).toBe(202);
    const body = resp.json<{
      requestId: string;
      status: string;
      message: string;
      pwaUrl: string;
    }>();
    expect(body.status).toBe('downloading');
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(body.message).toMatch(/Boy1/);
    expect(body.pwaUrl).toBe(`http://127.0.0.1:3737/feed?userId=${USER_ID}`);

    expect(applyMock).toHaveBeenCalledTimes(1);
    const event = applyMock.mock.calls[0]![0];
    expect(event.kind).toBe('create_share_sheet');
    expect(event.requestId).toBe(body.requestId);
    expect(event.input).toEqual({
      url: 'https://www.youtube.com/watch?v=happy123abc',
      userId: USER_ID,
      youtubeId: 'happy123abc',
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─── GET /requests/feed ─────────────────────────────────────────────────────

describe('GET /requests/feed', () => {
  // Anchor the bucket dates relative to "now" so the test stays correct
  // whichever day the suite runs on. The router uses ISO-day prefix matching
  // off `added_at`, so we feed in known timestamps for today / yesterday /
  // two days ago and assert the resulting buckets.
  function isoAt(daysAgo: number, hour = 12): string {
    const d = new Date();
    d.setUTCHours(hour, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString();
  }

  it('groups today into sections (requests / channels / recommended) and prior days into bare cards', async () => {
    insertRequestRow({
      request_id: 'today-share',
      status: 'ready',
      source: 'share_sheet',
      added_at: isoAt(0),
    });
    insertRequestRow({
      request_id: 'today-channel',
      status: 'ready',
      source: 'channel_subscription',
      added_at: isoAt(0, 10),
    });
    insertRequestRow({
      request_id: 'today-recommended',
      status: 'ready',
      source: 'recommended',
      added_at: isoAt(0, 8),
    });
    insertRequestRow({
      request_id: 'yesterday-share',
      status: 'ready',
      source: 'share_sheet',
      added_at: isoAt(1),
    });
    insertRequestRow({
      request_id: 'older-share',
      status: 'ready',
      source: 'share_sheet',
      added_at: isoAt(2),
    });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<{
      days: Array<{
        date: string;
        label: string;
        cards: Array<{ request_id: string }>;
        sections?: Array<{ id: string; label: string; cards: Array<{ request_id: string }> }>;
      }>;
    }>();

    // Days come back DESC by added_at — today first.
    expect(body.days.length).toBe(3);

    const [today, yesterday, older] = body.days;
    expect(today!.label).toBe('Today');
    expect(yesterday!.label).toBe('Yesterday');
    // "Mon 7 Apr"-style: short weekday, numeric day, short month.
    expect(older!.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);

    // Today carries `sections` for the share_sheet / channel_subscription /
    // recommended split; prior days don't.
    expect(today!.sections).toBeDefined();
    expect(yesterday!.sections).toBeUndefined();
    expect(older!.sections).toBeUndefined();

    const sectionsById = new Map(today!.sections!.map((s) => [s.id, s]));
    expect(sectionsById.get('requests')!.cards.map((c) => c.request_id)).toEqual(['today-share']);
    expect(sectionsById.get('channels')!.cards.map((c) => c.request_id)).toEqual(['today-channel']);
    expect(sectionsById.get('recommended')!.cards.map((c) => c.request_id)).toEqual([
      'today-recommended',
    ]);

    expect(yesterday!.cards.map((c) => c.request_id)).toEqual(['yesterday-share']);
    expect(older!.cards.map((c) => c.request_id)).toEqual(['older-share']);
  });

  it('excludes dismissed and deleted rows from the feed', async () => {
    insertRequestRow({
      request_id: 'visible',
      status: 'ready',
      source: 'share_sheet',
      added_at: isoAt(0),
    });
    insertRequestRow({
      request_id: 'hidden-dismissed',
      status: 'dismissed',
      source: 'share_sheet',
      added_at: isoAt(0),
    });
    insertRequestRow({
      request_id: 'hidden-deleted',
      status: 'deleted',
      source: 'share_sheet',
      added_at: isoAt(0),
    });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<{
      days: Array<{ cards: Array<{ request_id: string }> }>;
    }>();
    const ids = body.days.flatMap((d) => d.cards.map((c) => c.request_id));
    expect(ids).toContain('visible');
    expect(ids).not.toContain('hidden-dismissed');
    expect(ids).not.toContain('hidden-deleted');
  });

  it('excludes channel_subscription rows in pending or downloading state — the only thing stopping followed-channel feeds from flickering through pending', async () => {
    insertRequestRow({
      request_id: 'channel-pending',
      status: 'pending',
      source: 'channel_subscription',
      added_at: isoAt(0),
    });
    insertRequestRow({
      request_id: 'channel-downloading',
      status: 'downloading',
      source: 'channel_subscription',
      added_at: isoAt(0),
    });
    insertRequestRow({
      request_id: 'channel-ready',
      status: 'ready',
      source: 'channel_subscription',
      added_at: isoAt(0),
    });
    // The pending/downloading exclusion is scoped to channel_subscription —
    // share_sheet rows in those states must still appear.
    insertRequestRow({
      request_id: 'share-downloading',
      status: 'downloading',
      source: 'share_sheet',
      added_at: isoAt(0),
    });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<{
      days: Array<{ cards: Array<{ request_id: string }> }>;
    }>();
    const ids = body.days.flatMap((d) => d.cards.map((c) => c.request_id));
    expect(ids).toContain('channel-ready');
    expect(ids).toContain('share-downloading');
    expect(ids).not.toContain('channel-pending');
    expect(ids).not.toContain('channel-downloading');
  });

  it('applies displayRejectionReason to every outgoing row — sentinel becomes a human label', async () => {
    // CANCELLED_REASON sentinel ('__cancelled_by_user') must render as
    // 'Cancelled'; a freeform reason must pass through unchanged.
    insertRequestRow({
      request_id: 'cancelled-by-user',
      status: 'rejected',
      source: 'share_sheet',
      added_at: isoAt(0),
      rejection_reason: '__cancelled_by_user',
    });
    insertRequestRow({
      request_id: 'guard-blocked',
      status: 'rejected',
      source: 'share_sheet',
      added_at: isoAt(1),
      rejection_reason: 'Not suitable for this age band',
    });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<{
      days: Array<{ cards: Array<{ request_id: string; rejection_reason: string | null }> }>;
    }>();
    const byId = new Map(
      body.days.flatMap((d) => d.cards).map((c) => [c.request_id, c.rejection_reason]),
    );
    expect(byId.get('cancelled-by-user')).toBe('Cancelled');
    expect(byId.get('guard-blocked')).toBe('Not suitable for this age band');
  });

  it('returns 400 when neither userId nor user is provided', async () => {
    const resp = await request('GET', '/requests/feed');
    expect(resp.status).toBe(400);
  });
});

// ─── GET /requests — list endpoint (search-equivalent) ──────────────────────
//
// The acceptance criteria pair `GET /feed` with the `GET /search-equivalent`
// list endpoint (`GET /requests?user=...`) for the rejection-reason mapping —
// a regression that removed `displayRejectionReason` from this path would
// otherwise sneak past the feed-only assertion above.

describe('GET /requests (list)', () => {
  it('applies displayRejectionReason to every outgoing row', async () => {
    insertRequestRow({
      request_id: 'list-cancelled',
      status: 'rejected',
      source: 'share_sheet',
      rejection_reason: '__cancelled_by_user',
    });
    insertRequestRow({
      request_id: 'list-blocked',
      status: 'rejected',
      source: 'share_sheet',
      rejection_reason: 'Not suitable for this age band',
    });

    const resp = await request('GET', '/requests?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<{
      requests: Array<{ request_id: string; rejection_reason: string | null }>;
    }>();
    const byId = new Map(body.requests.map((r) => [r.request_id, r.rejection_reason]));
    expect(byId.get('list-cancelled')).toBe('Cancelled');
    expect(byId.get('list-blocked')).toBe('Not suitable for this age band');
  });

  it('returns 400 when neither userId nor user is provided', async () => {
    const resp = await request('GET', '/requests');
    expect(resp.status).toBe(400);
  });
});

// ─── Lifecycle POST smoke test ──────────────────────────────────────────────
//
// The five lifecycle POSTs (`/:id/watched`, `/save`, `/dismiss`, `/cancel`,
// `/delete`) are each thin delegates to the state machine, which is fully
// exercised in state.test.ts. One smoke per branch shape (204 / 404 / 409)
// is enough to defend the wiring; deeper coverage isn't worth duplicating.

describe('lifecycle POST endpoints (smoke)', () => {
  it('POST /requests/:id/watched returns 204 and applies mark_watched with the path id', async () => {
    insertRequestRow({ request_id: 'watch-req', status: 'ready' });
    applyMock.mockReturnValueOnce({
      result: { transitioned: true, userId: USER_ID },
      settled: Promise.resolve(),
    });

    const resp = await request('POST', '/requests/watch-req/watched');

    expect(resp.status).toBe(204);
    expect(applyMock).toHaveBeenCalledWith({ kind: 'mark_watched', requestId: 'watch-req' });
  });

  it('POST /requests/:id/cancel returns 409 when the state machine reports an illegal source status', async () => {
    // A `ready` request can't be cancelled — CANCELLABLE_SOURCES tops out at
    // `approved`. The router translates the descriptor's no-op (transitioned:
    // false, currentStatus: 'ready') into a 409 INVALID_STATE.
    insertRequestRow({ request_id: 'cancel-illegal', status: 'ready' });
    applyMock.mockReturnValueOnce({
      result: { transitioned: false, currentStatus: 'ready' },
      settled: Promise.resolve(),
    });

    const resp = await request('POST', '/requests/cancel-illegal/cancel');

    expect(resp.status).toBe(409);
    const body = resp.json<{ error: string; message: string }>();
    expect(body.error).toBe('INVALID_STATE');
    expect(body.message).toMatch(/ready/);
  });

  it('POST /requests/:id/delete returns 404 when the request id is unknown', async () => {
    applyMock.mockReturnValueOnce({
      result: { transitioned: false, currentStatus: null },
      settled: Promise.resolve(),
    });

    const resp = await request('POST', '/requests/does-not-exist/delete');

    expect(resp.status).toBe(404);
  });
});
