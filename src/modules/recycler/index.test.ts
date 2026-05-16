import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

// ── Mocks ────────────────────────────────────────────────────────────────────
//
// Quota and global cap stay small so the priority logic exercises with bytes
// you can read at a glance (sizes 100/200/500, quota 1000) rather than having
// to do GiB arithmetic in your head while reading the test.
vi.mock('../../config', () => ({
  config: {
    USER_STORAGE_QUOTA_BYTES: 1000,
    // Tight enough that two users each within their quota can collectively
    // push over — required for the global-cap test below.
    GLOBAL_STORAGE_CAP_BYTES: 1500,
  },
}));

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// BullMQ + Redis are off the critical path for the picker. recyclerQueue.add
// is captured so the scheduler smoke test can assert one registration call.
// `vi.hoisted` shares mock state between the (hoisted) `vi.mock` factories
// and the rest of the test file — without it the factory would close over
// a variable that's still in the TDZ at mock-init time.
const mocks = vi.hoisted(() => ({
  queueAddMock: vi.fn().mockResolvedValue(undefined),
  workerInstances: [] as Array<{ close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }>,
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => {
    const w = { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    mocks.workerInstances.push(w);
    return w;
  }),
}));

vi.mock('../../queue', () => ({
  redis: {},
  recyclerQueue: { add: mocks.queueAddMock },
  downloadQueue: {},
  deleteQueue: {},
}));

// The recycler reaches the state machine via `getRequestsState()`. We swap in
// a fake that records the apply calls and writes the same row mutations the
// real descriptor would, so the picker's next iteration sees an up-to-date
// bytes-per-user total.
const applyCalls: Array<{ requestId: string }> = [];
const enqueueDeleteCalls: Array<{ jobData: { requestId: string; filePath: string }; opts: { jobId: string } }> = [];

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { registerDefaultRequestsState, createRequestsState, type Ports } from '../requests';

const USER_A = '11111111-1111-7111-8111-111111111111';
const USER_B = '22222222-2222-7222-8222-222222222222';

function insertUser(userId: string, name: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, name, 'kid', 12, new Date().toISOString());
}

// Helper: insert a request row with the columns the recycler reads. status
// drives the priority tier; size drives the running budget; added_at /
// watched_at carry the secondary sort. file_path is required to trigger an
// enqueue effect on mark_recycled.
function insertReq(opts: {
  requestId?: string;
  userId: string;
  status: 'ready' | 'watched' | 'dismissed';
  size: number;
  addedAt: string;
  watchedAt?: string | null;
  savedAt?: string | null;
  fileState?: 'live' | 'recycled' | 'gone';
}): string {
  const requestId = opts.requestId ?? uuidv7();
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, status,
       file_path, nginx_url, file_size_bytes, file_state, saved_at,
       requested_at, added_at, watched_at)
    VALUES (?, ?, 'share_sheet', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    opts.userId,
    `https://www.youtube.com/watch?v=${requestId.slice(0, 11)}`,
    requestId.slice(0, 11),
    opts.status,
    `/videos/${requestId}.mp4`,
    `http://mediaserver/videos/${requestId}.mp4`,
    opts.size,
    opts.fileState ?? 'live',
    opts.savedAt ?? null,
    opts.addedAt,
    opts.addedAt,
    opts.watchedAt ?? null,
  );
  return requestId;
}

function insertWatchEvent(opts: {
  requestId: string;
  userId: string;
  endedAt: string;
}): void {
  db.prepare(`
    INSERT INTO watch_events
      (event_id, user_id, request_id, video_id, source, started_at, ended_at, position_s, duration_s, reason)
    VALUES (?, ?, ?, 'vid', 'feed', ?, ?, 1500, 1500, 'ended')
  `).run(uuidv7(), opts.userId, opts.requestId, opts.endedAt, opts.endedAt);
}

function fileState(requestId: string): string {
  const row = db.prepare('SELECT file_state FROM requests WHERE request_id = ?')
    .get(requestId) as { file_state: string } | undefined;
  return row?.file_state ?? 'missing';
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

// runRecyclerPass is imported lazily inside the tests so the mocked state is
// wired before the module captures `getRequestsState()`. (It's actually
// called per pass via the accessor, so it's safe to import eagerly, but
// the explicit pattern keeps the test setup obvious.)
let runRecyclerPass: typeof import('./index').runRecyclerPass;
let startRecyclerScheduler: typeof import('./index').startRecyclerScheduler;
let stopRecyclerScheduler: typeof import('./index').stopRecyclerScheduler;

beforeAll(async () => {
  runMigrations();
  insertUser(USER_A, 'Boy1');
  insertUser(USER_B, 'Boy2');

  // Wire a stub state machine that records applies and mirrors the real
  // mark_recycled SQL side-effects so the picker's accounting is correct
  // between iterations. The fake ports stay in place for the rest of the
  // tests; the picker doesn't observe them directly.
  const ports: Ports = {
    notifyVideoReady: vi.fn().mockResolvedValue(undefined),
    enqueueDownload: vi.fn().mockResolvedValue(undefined),
    enqueueDelete: vi.fn().mockImplementation((jobData, opts) => {
      enqueueDeleteCalls.push({ jobData, opts });
      return Promise.resolve();
    }),
    cancelDownloadJob: vi.fn().mockResolvedValue(undefined),
    redisDel: vi.fn().mockResolvedValue(1),
    ensurePerson: vi.fn().mockReturnValue({ personId: 'p', created: false }),
    applyChannelInfo: vi.fn().mockResolvedValue(undefined),
  };
  const realState = createRequestsState({ ports });
  registerDefaultRequestsState({
    apply: (event) => {
      if (event.kind === 'mark_recycled') applyCalls.push({ requestId: event.requestId });
      return realState.apply(event);
    },
  });

  const mod = await import('./index');
  runRecyclerPass = mod.runRecyclerPass;
  startRecyclerScheduler = mod.startRecyclerScheduler;
  stopRecyclerScheduler = mod.stopRecyclerScheduler;
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM watch_events');
  applyCalls.length = 0;
  enqueueDeleteCalls.length = 0;
  mocks.queueAddMock.mockClear();
  mocks.workerInstances.length = 0;
});

// ── Per-user quota ───────────────────────────────────────────────────────────

describe('runRecyclerPass — per-user quota', () => {
  it('recycles enough victims to bring a single user back under their quota', () => {
    // Five 500-byte rows = 2500 bytes total, quota = 1000. Need to free at
    // least 1500 bytes (3 rows worth). All same tier (dismissed) so the only
    // thing varying is `added_at`: oldest three should go.
    const oldestThree = [10, 8, 6].map((days) =>
      insertReq({ userId: USER_A, status: 'dismissed', size: 500, addedAt: isoDaysAgo(days) }),
    );
    const newest = [4, 2].map((days) =>
      insertReq({ userId: USER_A, status: 'dismissed', size: 500, addedAt: isoDaysAgo(days) }),
    );

    const result = runRecyclerPass();

    expect(result.perUserRecycled).toBe(3);
    expect(result.globalRecycled).toBe(0);
    expect(result.bytesFreed).toBe(1500);

    for (const id of oldestThree) expect(fileState(id)).toBe('recycled');
    for (const id of newest) expect(fileState(id)).toBe('live');
  });

  it('leaves users at or under quota alone', () => {
    const id = insertReq({ userId: USER_A, status: 'ready', size: 1000, addedAt: isoDaysAgo(10) });

    const result = runRecyclerPass();

    expect(result.perUserRecycled).toBe(0);
    expect(fileState(id)).toBe('live');
  });
});

// ── Priority order, one tier in isolation per test ───────────────────────────

describe('runRecyclerPass — priority tiers in isolation', () => {
  it('tier 1: dismissed rows are picked before any other tier', () => {
    // User is 600 bytes over (1600 vs 1000). Have one dismissed (200), one
    // watched (200), one old ready (200), one fresh ready (1000). The picker
    // should reach for the dismissed row first; it covers only 200, so the
    // pass continues into tier 2 (watched), then tier 3 (ready), but stops
    // when the running total falls back under quota.
    const dismissed = insertReq({ userId: USER_A, status: 'dismissed', size: 200, addedAt: isoDaysAgo(1) });
    const watched = insertReq({ userId: USER_A, status: 'watched', size: 200, addedAt: isoDaysAgo(10), watchedAt: isoDaysAgo(9) });
    const oldReady = insertReq({ userId: USER_A, status: 'ready', size: 200, addedAt: isoDaysAgo(10) });
    const freshReady = insertReq({ userId: USER_A, status: 'ready', size: 1000, addedAt: isoHoursAgo(1) });

    runRecyclerPass();

    expect(fileState(dismissed)).toBe('recycled');
    expect(fileState(watched)).toBe('recycled');
    expect(fileState(oldReady)).toBe('recycled');
    // Fresh ready is excluded by the 48h skip; it also wouldn't be reached
    // because the running total drops under quota after the third pick.
    expect(fileState(freshReady)).toBe('live');
  });

  it('tier 2: watched rows are picked in latest-event-ascending order (re-watched stays alive)', () => {
    // Two watched rows, each 800 bytes. User is 600 bytes over (1600 vs 1000).
    // Tier 2 order is "oldest last engagement first" — the row whose latest
    // watch_event is older should recycle first.
    const olderEngagement = insertReq({
      userId: USER_A, status: 'watched', size: 800, addedAt: isoDaysAgo(30),
      watchedAt: isoDaysAgo(20),
    });
    const recentEngagement = insertReq({
      userId: USER_A, status: 'watched', size: 800, addedAt: isoDaysAgo(30),
      watchedAt: isoDaysAgo(20),
    });
    // Re-watched yesterday — should stay alive longer.
    insertWatchEvent({ requestId: olderEngagement, userId: USER_A, endedAt: isoDaysAgo(20) });
    insertWatchEvent({ requestId: recentEngagement, userId: USER_A, endedAt: isoDaysAgo(20) });
    insertWatchEvent({ requestId: recentEngagement, userId: USER_A, endedAt: isoDaysAgo(1) });

    runRecyclerPass();

    expect(fileState(olderEngagement)).toBe('recycled');
    expect(fileState(recentEngagement)).toBe('live');
  });

  it('tier 3: ready rows are picked oldest-first by added_at', () => {
    // No dismissed, no watched. Three ready rows: two over the 48h boundary,
    // one under. User is 600 bytes over (1600 vs 1000). Oldest of the two
    // eligible should recycle.
    const oldest = insertReq({ userId: USER_A, status: 'ready', size: 600, addedAt: isoDaysAgo(10) });
    const middle = insertReq({ userId: USER_A, status: 'ready', size: 600, addedAt: isoDaysAgo(5) });
    const tooFresh = insertReq({ userId: USER_A, status: 'ready', size: 400, addedAt: isoHoursAgo(12) });

    runRecyclerPass();

    expect(fileState(oldest)).toBe('recycled');
    expect(fileState(middle)).toBe('live');
    expect(fileState(tooFresh)).toBe('live');
  });

  it('tier 4: saved rows are never recycled regardless of status, age, or budget pressure', () => {
    // Saved dismissed + saved watched + saved ancient ready (each 1000
    // bytes) sit alongside a 1500-byte unsaved dismissed row. Eligible
    // total = 1500 (saved bytes are excluded from the quota maths because
    // the picker can never reach them, and including them would penalise
    // the user for content the recycler refuses to touch). 1500 > 1000
    // quota, so the picker fires — but only the eligible row is fair game.
    const savedDismissed = insertReq({
      userId: USER_A, status: 'dismissed', size: 1000, addedAt: isoDaysAgo(100),
      savedAt: isoDaysAgo(50),
    });
    const savedWatched = insertReq({
      userId: USER_A, status: 'watched', size: 1000, addedAt: isoDaysAgo(100),
      watchedAt: isoDaysAgo(90),
      savedAt: isoDaysAgo(50),
    });
    const savedAncientReady = insertReq({
      userId: USER_A, status: 'ready', size: 1000, addedAt: isoDaysAgo(100),
      savedAt: isoDaysAgo(50),
    });
    const eligibleDismissed = insertReq({ userId: USER_A, status: 'dismissed', size: 1500, addedAt: isoDaysAgo(1) });

    runRecyclerPass();

    expect(fileState(savedDismissed)).toBe('live');
    expect(fileState(savedWatched)).toBe('live');
    expect(fileState(savedAncientReady)).toBe('live');
    expect(fileState(eligibleDismissed)).toBe('recycled');
  });
});

// ── 48h skip ─────────────────────────────────────────────────────────────────

describe('runRecyclerPass — 48h skip for unwatched', () => {
  it('does not pick a 30-hour-old ready row even when the user is over and nothing else is eligible', () => {
    // User is 200 bytes over (1200 vs 1000). The only thing in the feed is
    // a 1200-byte ready row added 30 hours ago — well inside the 48h grace
    // window. The recycler should leave it alone, even though that means
    // the user stays over budget for tonight.
    const freshReady = insertReq({ userId: USER_A, status: 'ready', size: 1200, addedAt: isoHoursAgo(30) });

    const result = runRecyclerPass();

    expect(result.perUserRecycled).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(fileState(freshReady)).toBe('live');
  });
});

// ── Global cap ───────────────────────────────────────────────────────────────

describe('runRecyclerPass — global cap', () => {
  it('keeps recycling across users when each is under per-user but the pool is over global cap', () => {
    // Quota = 1000, global cap = 1500. Two users each with 900 bytes
    // (under their per-user quota) — pool is 1800, 300 over the cap.
    // The global sweep should pick the older of the two dismissed rows.
    const userAOlder = insertReq({
      userId: USER_A, status: 'dismissed', size: 900, addedAt: isoDaysAgo(20),
    });
    const userBNewer = insertReq({
      userId: USER_B, status: 'dismissed', size: 900, addedAt: isoDaysAgo(5),
    });

    const result = runRecyclerPass();

    expect(result.perUserRecycled).toBe(0);
    expect(result.globalRecycled).toBe(1);
    expect(result.bytesFreed).toBe(900);

    expect(fileState(userAOlder)).toBe('recycled');
    expect(fileState(userBNewer)).toBe('live');
  });
});

// ── Effect lands on the existing delete queue ────────────────────────────────

describe('runRecyclerPass — delete queue', () => {
  it('routes file unlinks through the existing delete queue with the same jobId shape as soft-delete', () => {
    const id = insertReq({ userId: USER_A, status: 'dismissed', size: 1500, addedAt: isoDaysAgo(5) });

    runRecyclerPass();

    expect(enqueueDeleteCalls).toHaveLength(1);
    expect(enqueueDeleteCalls[0]).toEqual({
      jobData: { requestId: id, filePath: `/videos/${id}.mp4` },
      opts: { jobId: `delete-${id}` },
    });
    // Same jobId shape mark_soft_deleted uses — no colons (BullMQ custom
    // job IDs allow 0 or exactly 2 colons; this needs 0).
    expect(enqueueDeleteCalls[0].opts.jobId).not.toContain(':');
  });
});

// ── Scheduler registration smoke ─────────────────────────────────────────────

describe('startRecyclerScheduler', () => {
  it('registers the daily repeatable on start and tears down cleanly on stop', async () => {
    startRecyclerScheduler();

    expect(mocks.queueAddMock).toHaveBeenCalledTimes(1);
    expect(mocks.queueAddMock).toHaveBeenCalledWith(
      'run', {}, expect.objectContaining({
        repeat: expect.objectContaining({ pattern: '0 4 * * *' }),
        jobId: 'recycler-daily',
      }),
    );
    expect(mocks.workerInstances).toHaveLength(1);

    await stopRecyclerScheduler();
    expect(mocks.workerInstances[0]!.close).toHaveBeenCalledTimes(1);
  });
});
