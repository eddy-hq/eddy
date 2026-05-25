import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
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
  downloadQueue: { getJob: vi.fn(), add: vi.fn().mockResolvedValue(undefined) },
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
import { downloadQueue } from '../../queue';
import {
  FEED_LIMIT,
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

// Supertest drives `app` directly via an ephemeral loopback socket it manages
// itself — no manual `listen()`, no port flags. Wrapped here so call sites
// stay framework-agnostic (and the existing `resp.json<T>()` shape continues
// to work).
async function request(
  method: string,
  path: string,
  init: { body?: unknown } = {},
): Promise<RouterResponse> {
  const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
  let req = supertest(app)[verb](path);
  if (init.body !== undefined) {
    req = req.set('Content-Type', 'application/json').send(init.body as object);
  }
  const res = await req;
  return {
    status: res.status,
    headers: res.headers,
    body: res.text ?? '',
    json: <T = unknown>() => (res.text ? (JSON.parse(res.text) as T) : (res.body as T)),
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
  vi.mocked(downloadQueue.add).mockReset().mockResolvedValue(undefined as never);
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
  channel?: string | null;
  added_at?: string;
  requested_at?: string;
  rejection_reason?: string | null;
  file_state?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, title, channel, status,
        rejection_reason, requested_at, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.request_id,
    opts.user_id ?? USER_ID,
    opts.source ?? 'share_sheet',
    opts.url ?? 'https://www.youtube.com/watch?v=' + opts.request_id,
    opts.youtube_id ?? null,
    opts.title ?? null,
    opts.channel ?? null,
    opts.status,
    opts.rejection_reason ?? null,
    opts.requested_at ?? now,
    opts.added_at ?? now,
  );
  if (opts.file_state !== undefined) {
    db.prepare('UPDATE requests SET file_state = ? WHERE request_id = ?')
      .run(opts.file_state, opts.request_id);
  }
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
    // resolveUrl in index.ts follows redirects via `fetch` for any non-YouTube
    // URL on the way in (share.google / youtu.be / Shortcut shimmed URLs).
    // Stub the global fetch so this assertion exercises the validation gate
    // without making real network I/O — the brief explicitly puts `resolveUrl`
    // integration coverage out of scope.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    try {
      const resp = await request('POST', '/requests', {
        body: { url: 'https://example.com/not-youtube', user: 'Boy1' },
      });

      expect(resp.status).toBe(400);
      expect(resp.json<{ error: string }>().error).toBe('VALIDATION_ERROR');
      expect(applyMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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

  it('groups today into two sections (You asked / unified Today) and prior days into bare cards', async () => {
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

    // Today collapses to two sections (ADR-0009): "You asked" (share_sheet)
    // and a unified "Today" mixing channel_subscription + recommended; prior
    // days carry no sections.
    expect(today!.sections).toBeDefined();
    expect(yesterday!.sections).toBeUndefined();
    expect(older!.sections).toBeUndefined();

    const sectionsById = new Map(today!.sections!.map((s) => [s.id, s]));
    expect(today!.sections!.map((s) => s.id)).toEqual(['requests', 'today']);
    expect(sectionsById.get('requests')!.cards.map((c) => c.request_id)).toEqual(['today-share']);
    // The unified Today stream carries both follow + pick rows, ordered by the
    // feed's added_at DESC (today-channel at 10:00 before today-recommended at
    // 08:00).
    expect(sectionsById.get('today')!.cards.map((c) => c.request_id)).toEqual([
      'today-channel',
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

  it('keeps the temporary feed cap above the legacy 200-row cutoff until old-day summaries exist', async () => {
    expect(FEED_LIMIT).toBeGreaterThan(200);

    const baseTime = new Date(isoAt(0)).getTime();
    for (let i = 0; i < 201; i += 1) {
      insertRequestRow({
        request_id: `feed-cap-${i}`,
        status: 'ready',
        source: 'share_sheet',
        added_at: new Date(baseTime - i * 1000).toISOString(),
      });
    }

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<{
      days: Array<{ cards: Array<{ request_id: string }>; sections?: Array<{ cards: Array<{ request_id: string }> }> }>;
    }>();
    const ids = body.days.flatMap((d) => d.sections ? d.sections.flatMap((s) => s.cards) : d.cards).map((c) => c.request_id);

    expect(ids).toHaveLength(201);
    expect(ids).toContain('feed-cap-200');
  });

  it('returns 400 when neither userId nor user is provided', async () => {
    const resp = await request('GET', '/requests/feed');
    expect(resp.status).toBe(400);
  });

  // ─── Tier 3 / Tier 4 summaries (issue #140) ───────────────────────────────
  //
  // Additive top-level fields alongside `days`. Tier 3 = per-day summaries for
  // rows aged 7–29 days; Tier 4 = per-week (Mon–Sun) summaries for rows aged
  // ≥ 30 days. Rows aged < 7 days stay in `days` only. Age is a whole-day
  // calendar delta from today.

  interface TierBody {
    days: Array<{ date: string; cards: Array<{ request_id: string }>; sections?: Array<{ cards: Array<{ request_id: string }> }> }>;
    tier3Days: Array<{
      date: string;
      count: number;
      provenanceMix: { req: number; follow: number; pick: number };
      topTitles: Array<{ title: string; kind: 'req' | 'follow' | 'pick' }>;
    }>;
    tier4Weeks: Array<{
      rangeStart: string;
      rangeEnd: string;
      count: number;
      topChannels: string[];
      summary: string | null;
    }>;
  }

  it('(a) <7d history: tier3Days and tier4Weeks are empty, days carries the rows unchanged', async () => {
    insertRequestRow({ request_id: 'recent-0', status: 'ready', source: 'share_sheet', added_at: isoAt(0) });
    insertRequestRow({ request_id: 'recent-3', status: 'ready', source: 'share_sheet', added_at: isoAt(3) });
    insertRequestRow({ request_id: 'recent-6', status: 'ready', source: 'share_sheet', added_at: isoAt(6) });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();

    // Nothing aged into Tier 3/4 yet.
    expect(body.tier3Days).toEqual([]);
    expect(body.tier4Weeks).toEqual([]);

    // The <7d rows are all present in `days` (full rows), unchanged.
    const dayIds = body.days.flatMap((d) => d.sections ? d.sections.flatMap((s) => s.cards) : d.cards).map((c) => c.request_id);
    expect(dayIds).toEqual(expect.arrayContaining(['recent-0', 'recent-3', 'recent-6']));
    expect(dayIds).toHaveLength(3);
  });

  it('(b) 7–30d history: tier3Days is populated with per-day provenanceMix + topTitles (max 3, most-recent-first)', async () => {
    // Four rows on the same day (age 10) of mixed provenance; topTitles caps at
    // 3 and follows the added_at DESC ordering (latest hour first).
    insertRequestRow({ request_id: 't3-a', status: 'ready', source: 'share_sheet', title: 'Asked One', added_at: isoAt(10, 9) });
    insertRequestRow({ request_id: 't3-b', status: 'ready', source: 'channel_subscription', title: 'Follow Two', added_at: isoAt(10, 11) });
    insertRequestRow({ request_id: 't3-c', status: 'ready', source: 'recommended', title: 'Pick Three', added_at: isoAt(10, 13) });
    insertRequestRow({ request_id: 't3-d', status: 'ready', source: 'share_sheet', title: 'Asked Four', added_at: isoAt(10, 15) });
    // A second Tier-3 day (age 8) to confirm dates come back DESC.
    insertRequestRow({ request_id: 't3-e', status: 'ready', source: 'share_sheet', title: 'Newer Day', added_at: isoAt(8) });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();

    expect(body.tier4Weeks).toEqual([]);
    // `days` is the full history regardless of age (Saved.tsx depends on it),
    // so every seeded row is still present there — the tiers are additive
    // summaries layered on top, not a partition of `days`.
    const dayIds = body.days.flatMap((d) => d.sections ? d.sections.flatMap((s) => s.cards) : d.cards).map((c) => c.request_id);
    expect(dayIds.sort()).toEqual(['t3-a', 't3-b', 't3-c', 't3-d', 't3-e'].sort());

    expect(body.tier3Days.map((d) => d.date)).toEqual([isoAt(8).slice(0, 10), isoAt(10).slice(0, 10)]);

    const day10 = body.tier3Days.find((d) => d.date === isoAt(10).slice(0, 10))!;
    expect(day10.count).toBe(4);
    expect(day10.provenanceMix).toEqual({ req: 2, follow: 1, pick: 1 });
    // Ordered most-recent-first (added_at DESC), capped at 3.
    expect(day10.topTitles).toEqual([
      { title: 'Asked Four', kind: 'req' },
      { title: 'Pick Three', kind: 'pick' },
      { title: 'Follow Two', kind: 'follow' },
    ]);
  });

  it('(c) 30+d history: tier4Weeks is populated, with topChannels by count and summary null', async () => {
    // Age 40 falls in one ISO week. Three rows: Channel X twice, Channel Y once.
    insertRequestRow({ request_id: 't4-a', status: 'ready', source: 'channel_subscription', channel: 'Channel X', added_at: isoAt(40, 9) });
    insertRequestRow({ request_id: 't4-b', status: 'ready', source: 'channel_subscription', channel: 'Channel Y', added_at: isoAt(40, 11) });
    insertRequestRow({ request_id: 't4-c', status: 'ready', source: 'channel_subscription', channel: 'Channel X', added_at: isoAt(41, 9) });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();

    // `days` still carries the full history; only the tier summaries partition
    // by age. These rows are all ≥30d, so Tier 3 is empty and Tier 4 has them.
    const dayIds = body.days.flatMap((d) => d.cards).map((c) => c.request_id);
    expect(dayIds.sort()).toEqual(['t4-a', 't4-b', 't4-c'].sort());
    expect(body.tier3Days).toEqual([]);
    expect(body.tier4Weeks).toHaveLength(1);

    const week = body.tier4Weeks[0]!;
    expect(week.count).toBe(3);
    expect(week.topChannels).toEqual(['Channel X', 'Channel Y']);
    expect(week.summary).toBeNull();
    // rangeStart is a Monday, rangeEnd the following Sunday (6 days later).
    expect(new Date(week.rangeStart + 'T00:00:00Z').getUTCDay()).toBe(1);
    expect(new Date(week.rangeEnd + 'T00:00:00Z').getUTCDay()).toBe(0);
    const spanDays = (Date.parse(week.rangeEnd) - Date.parse(week.rangeStart)) / 86_400_000;
    expect(spanDays).toBe(6);
  });

  it('(d) a Tier-4 week that spans a month boundary is one week with a cross-month range', async () => {
    // Find a Monday that sits in a different month from the Sunday of that week,
    // and is at least 30 days old, by walking back from today.
    function mondayOf(d: Date): Date {
      const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const monday = ms - (((new Date(ms).getUTCDay() + 6) % 7) * 86_400_000);
      return new Date(monday);
    }
    const probe = new Date();
    probe.setUTCDate(probe.getUTCDate() - 35);
    let monday = mondayOf(probe);
    // Walk back a week at a time until the Mon–Sun span crosses a month edge.
    for (let i = 0; i < 12; i += 1) {
      const sunday = new Date(monday.getTime() + 6 * 86_400_000);
      if (monday.getUTCMonth() !== sunday.getUTCMonth()) break;
      monday = new Date(monday.getTime() - 7 * 86_400_000);
    }
    const sunday = new Date(monday.getTime() + 6 * 86_400_000);
    expect(monday.getUTCMonth()).not.toBe(sunday.getUTCMonth());

    const mondayIso = monday.toISOString().slice(0, 10);
    const sundayIso = sunday.toISOString().slice(0, 10);
    insertRequestRow({ request_id: 't4-mon', status: 'ready', source: 'channel_subscription', channel: 'Cross', added_at: monday.toISOString() });
    insertRequestRow({ request_id: 't4-sun', status: 'ready', source: 'channel_subscription', channel: 'Cross', added_at: sunday.toISOString() });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();

    expect(body.tier4Weeks).toHaveLength(1);
    const week = body.tier4Weeks[0]!;
    expect(week.rangeStart).toBe(mondayIso);
    expect(week.rangeEnd).toBe(sundayIso);
    expect(week.count).toBe(2);
  });

  it('(e) no items: tier3Days and tier4Weeks are empty arrays, not a crash', async () => {
    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();
    expect(body.days).toEqual([]);
    expect(body.tier3Days).toEqual([]);
    expect(body.tier4Weeks).toEqual([]);
  });

  it('(f) boundary days: age exactly 7 → tier3, exactly 30 → tier4, age 6 → no tier, age 29 → tier3', async () => {
    insertRequestRow({ request_id: 'age-6', status: 'ready', source: 'share_sheet', added_at: isoAt(6) });
    insertRequestRow({ request_id: 'age-7', status: 'ready', source: 'share_sheet', added_at: isoAt(7) });
    insertRequestRow({ request_id: 'age-29', status: 'ready', source: 'share_sheet', added_at: isoAt(29) });
    insertRequestRow({ request_id: 'age-30', status: 'ready', source: 'channel_subscription', channel: 'Boundary', added_at: isoAt(30) });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();

    // `days` carries the whole history regardless of age — all four rows.
    const dayIds = body.days.flatMap((d) => d.sections ? d.sections.flatMap((s) => s.cards) : d.cards).map((c) => c.request_id);
    expect(dayIds.sort()).toEqual(['age-29', 'age-30', 'age-6', 'age-7'].sort());

    // age 6 → not summarised into a tier (Tier 1+2 / `days` only).
    const t3Andt4Dates = [
      ...body.tier3Days.map((d) => d.date),
    ];
    expect(t3Andt4Dates).not.toContain(isoAt(6).slice(0, 10));

    // age 7 and age 29 → Tier 3 (each its own day); age 30 not in Tier 3.
    const t3Dates = body.tier3Days.map((d) => d.date);
    expect(t3Dates).toContain(isoAt(7).slice(0, 10));
    expect(t3Dates).toContain(isoAt(29).slice(0, 10));
    expect(t3Dates).not.toContain(isoAt(30).slice(0, 10));

    // age 30 → Tier 4.
    expect(body.tier4Weeks).toHaveLength(1);
    expect(body.tier4Weeks[0]!.count).toBe(1);
    expect(body.tier4Weeks[0]!.topChannels).toEqual(['Boundary']);
  });

  it('unknown/legacy source values bucket to req in the Tier-3 provenanceMix rather than crashing', async () => {
    insertRequestRow({ request_id: 't3-legacy', status: 'ready', source: 'dns_landing', title: 'Legacy', added_at: isoAt(10) });
    insertRequestRow({ request_id: 't3-search', status: 'ready', source: 'search', title: 'Searched', added_at: isoAt(10) });

    const resp = await request('GET', '/requests/feed?user=Boy1');
    expect(resp.status).toBe(200);
    const body = resp.json<TierBody>();

    const day = body.tier3Days.find((d) => d.date === isoAt(10).slice(0, 10))!;
    expect(day.provenanceMix).toEqual({ req: 2, follow: 0, pick: 0 });
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
// The four lifecycle POSTs (`/:id/watched`, `/save`, `/cancel`, `/delete`)
// are each thin delegates to the state machine, which is fully exercised in
// state.test.ts. One smoke per branch shape (204 / 404 / 409) is enough to
// defend the wiring; deeper coverage isn't worth duplicating.

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

// ─── POST /requests/:id/restore (issue #116) ────────────────────────────────
//
// The four response paths the issue calls out: 202 for recycled / 400 for
// live / 400 for gone / 404 for unknown. The endpoint does not go through
// `apply`, it enqueues directly — assert on the `downloadQueue.add` mock and
// confirm `applyMock` was never touched.

describe('POST /requests/:id/restore', () => {
  it('returns 202 with the jobId for a recycled row and enqueues mode:restore', async () => {
    insertRequestRow({
      request_id: 'restore-ok',
      status: 'watched',
      youtube_id: 'restoreyt01',
      url: 'https://www.youtube.com/watch?v=restoreyt01',
      file_state: 'recycled',
    });

    const resp = await request('POST', '/requests/restore-ok/restore');

    expect(resp.status).toBe(202);
    const body = resp.json<{ requestId: string; jobId: string }>();
    expect(body.requestId).toBe('restore-ok');
    // jobId is `restore-${requestId}` so it can't collide with the original
    // download's completed job (still in BullMQ's retained-completions list).
    expect(body.jobId).toBe('restore-restore-ok');

    expect(vi.mocked(downloadQueue.add)).toHaveBeenCalledTimes(1);
    const [name, jobData, opts] = vi.mocked(downloadQueue.add).mock.calls[0]!;
    expect(name).toBe('download');
    expect(jobData).toEqual({
      requestId: 'restore-ok',
      youtubeId: 'restoreyt01',
      url: 'https://www.youtube.com/watch?v=restoreyt01',
      mode: 'restore',
    });
    expect(opts).toEqual({ jobId: 'restore-restore-ok' });
    // Defensive: jobId must not contain a colon — see CLAUDE.md on the
    // BullMQ custom-job-id colon constraint (single colon throws synchronously
    // and silently drops the job).
    expect((opts as { jobId: string }).jobId).not.toContain(':');

    // Restore does not transition state on the M4 — that happens via the
    // worker callback later. Apply must not be touched.
    expect(applyMock).not.toHaveBeenCalled();
  });

  // Regression for the codex round-1 finding: the original download job ran
  // with `jobId: requestId` and BullMQ retains completed jobs by default
  // (removeOnComplete: { count: 100 }). The restore enqueue must use a
  // distinct jobId so a duplicate add doesn't silently no-op against the
  // still-present completed download job — which would return 202 to the
  // user while the worker never ran.
  it('uses a `restore-` prefixed jobId distinct from the original download id', async () => {
    insertRequestRow({
      request_id: 'distinct-id-check',
      status: 'watched',
      youtube_id: 'someyt0001',
      file_state: 'recycled',
    });

    const resp = await request('POST', '/requests/distinct-id-check/restore');
    expect(resp.status).toBe(202);

    const [, , opts] = vi.mocked(downloadQueue.add).mock.calls[0]!;
    expect((opts as { jobId: string }).jobId).toBe('restore-distinct-id-check');
    expect((opts as { jobId: string }).jobId).not.toBe('distinct-id-check');
  });

  // Regression for the codex round-2 finding: a video can be restored, then
  // recycled again, then restored again — and the second restore must
  // actually enqueue, not no-op against the prior completed `restore-${id}`
  // job that BullMQ still has in its retained-completions list. The router
  // calls `downloadQueue.getJob(jobId)` + `remove()` first to clear the
  // stale entry, mirroring the retry descriptor's `cancel_download_job_awaited`
  // → `enqueue_download` sequencing.
  it('removes a prior completed restore job before re-adding so a re-restore actually enqueues', async () => {
    insertRequestRow({
      request_id: 'rerestore',
      status: 'watched',
      youtube_id: 'rerestoreyt',
      file_state: 'recycled',
    });
    const removeMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(downloadQueue.getJob).mockResolvedValueOnce({ remove: removeMock } as never);

    const resp = await request('POST', '/requests/rerestore/restore');
    expect(resp.status).toBe(202);

    // getJob must be called against the restore jobId, not the bare requestId.
    expect(vi.mocked(downloadQueue.getJob)).toHaveBeenCalledWith('restore-rerestore');
    expect(removeMock).toHaveBeenCalledTimes(1);
    // And then the add fires with the same jobId — the slot is now clear.
    expect(vi.mocked(downloadQueue.add)).toHaveBeenCalledTimes(1);
    const [, , opts] = vi.mocked(downloadQueue.add).mock.calls[0]!;
    expect((opts as { jobId: string }).jobId).toBe('restore-rerestore');
  });

  // Defensive: if the pre-add cleanup fails (e.g. Redis flake), the restore
  // still attempts the add — we don't block the user's intent on a flaky
  // remove that might be operating on a phantom job anyway.
  it('still enqueues when the pre-add getJob/remove throws', async () => {
    insertRequestRow({
      request_id: 'flaky-cleanup',
      status: 'watched',
      youtube_id: 'flakyy00001',
      file_state: 'recycled',
    });
    vi.mocked(downloadQueue.getJob).mockRejectedValueOnce(new Error('redis flaked'));

    const resp = await request('POST', '/requests/flaky-cleanup/restore');
    expect(resp.status).toBe(202);
    expect(vi.mocked(downloadQueue.add)).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for a live row with a descriptive error body and does not enqueue', async () => {
    insertRequestRow({
      request_id: 'restore-live',
      status: 'ready',
      file_state: 'live',
    });

    const resp = await request('POST', '/requests/restore-live/restore');

    expect(resp.status).toBe(400);
    const body = resp.json<{ error: string; message: string }>();
    expect(body.error).toBe('INVALID_STATE');
    expect(body.message).toMatch(/live/);
    expect(vi.mocked(downloadQueue.add)).not.toHaveBeenCalled();
  });

  it('returns 400 for a gone row with a descriptive error body and does not enqueue', async () => {
    insertRequestRow({
      request_id: 'restore-gone',
      status: 'deleted',
      file_state: 'gone',
    });

    const resp = await request('POST', '/requests/restore-gone/restore');

    expect(resp.status).toBe(400);
    const body = resp.json<{ error: string; message: string }>();
    expect(body.error).toBe('INVALID_STATE');
    expect(body.message).toMatch(/gone/);
    expect(vi.mocked(downloadQueue.add)).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown id and does not enqueue', async () => {
    const resp = await request('POST', '/requests/does-not-exist/restore');

    expect(resp.status).toBe(404);
    expect(vi.mocked(downloadQueue.add)).not.toHaveBeenCalled();
  });

  it('returns 500 when the queue enqueue throws and surfaces a clear error body', async () => {
    insertRequestRow({
      request_id: 'restore-enqfail',
      status: 'watched',
      youtube_id: 'restoreyt02',
      file_state: 'recycled',
    });
    vi.mocked(downloadQueue.add).mockRejectedValueOnce(new Error('redis down'));

    const resp = await request('POST', '/requests/restore-enqfail/restore');

    expect(resp.status).toBe(500);
    const body = resp.json<{ error: string }>();
    expect(body.error).toBe('ENQUEUE_FAILED');
  });

  // youtube_id is mandatory for restore: the worker keys the file path and
  // the completion callback URL on it, so a null would post to
  // `/internal/videos//restored` and never match the route — silently
  // breaking the round trip while the endpoint returned 202.
  it('returns 400 MISSING_YOUTUBE_ID when the row has no youtube_id, and does not enqueue', async () => {
    insertRequestRow({
      request_id: 'restore-noid',
      status: 'watched',
      youtube_id: null,
      file_state: 'recycled',
    });

    const resp = await request('POST', '/requests/restore-noid/restore');

    expect(resp.status).toBe(400);
    const body = resp.json<{ error: string }>();
    expect(body.error).toBe('MISSING_YOUTUBE_ID');
    expect(vi.mocked(downloadQueue.add)).not.toHaveBeenCalled();
  });
});
