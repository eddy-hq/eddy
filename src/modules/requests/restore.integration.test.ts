import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test for the restore round trip (issue #116). Asserts the
// acceptance criteria end-to-end: seed a `file_state = 'recycled'` row, call
// `POST /requests/:id/restore`, simulate the worker callback by firing
// `mark_restored` through the real state machine, then assert the row's
// end-state and that `guard_eval` row count is unchanged (the guard must not
// re-evaluate on restore).
//
// Unlike router.test.ts this exercises the real state machine (not mocked),
// because the acceptance criteria are about the actual DB columns the
// transition writes — mocking apply() would prove nothing.

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

// Real queue would talk to Redis; the integration test only cares that the
// enqueue happens with the right args, so we capture calls on a mock. The
// state machine itself isn't routed through this mock — restore enqueues
// directly from the router. The `vi.hoisted` keeps the mock fn reference
// reachable from the hoisted `vi.mock` factory below.
const { downloadQueueAdd } = vi.hoisted(() => ({
  downloadQueueAdd: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../queue', () => ({
  redis: { get: vi.fn(), del: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: downloadQueueAdd },
  deleteQueue: { add: vi.fn().mockResolvedValue(undefined) },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn().mockResolvedValue(undefined) }),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

// Don't mock state-default — we want the real state machine so the SQL the
// transitions write is the real SQL, and the integration test actually
// exercises mark_restored end-to-end.

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { requestsRouter, getRequestsState } from './index';

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

const USER_ID = '11111111-1111-7111-8111-111111111111';
const FILE_PATH = '/mnt/ssd/eddy/videos/restored.mp4';
const NGINX_URL = 'http://mediaserver/videos/restored.mp4';
const THUMB_URL = 'https://existing/editorial.jpg';

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM guard_eval');
  downloadQueueAdd.mockClear();
});

function seedRecycledRow(opts: { requestId: string; status: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, title, channel, status,
        file_path, nginx_url, thumbnail_url, file_state, file_size_bytes,
        recycled_at, requested_at, added_at, watched_at)
     VALUES (?, ?, 'share_sheet', ?, ?, ?, ?, ?, NULL, NULL, ?, 'recycled', NULL,
             '2026-04-01T00:00:00.000Z', ?, ?, ?)`,
  ).run(
    opts.requestId,
    USER_ID,
    `https://www.youtube.com/watch?v=${opts.requestId}`,
    opts.requestId,
    'Original title',
    'Original channel',
    opts.status,
    THUMB_URL,
    now,
    now,
    opts.status === 'watched' ? now : null,
  );
}

// Helper mirroring what the M4 internal `/internal/videos/:id/restored`
// handler does when the worker callback fires — we don't need to spin
// the worker's actual HTTP stack to assert the state transition, only to
// call `mark_restored` with the same payload shape the worker would post.
function simulateWorkerRestoredCallback(opts: {
  requestId: string;
  filePath: string;
  nginxUrl: string | null;
  thumbnailUrl: string | null;
  fileSizeBytes: number | null;
}): void {
  getRequestsState().apply({
    kind: 'mark_restored',
    requestId: opts.requestId,
    fields: {
      filePath: opts.filePath,
      nginxUrl: opts.nginxUrl,
      thumbnailUrl: opts.thumbnailUrl,
      fileSizeBytes: opts.fileSizeBytes,
    },
  });
}

async function postRestore(requestId: string) {
  return supertest(app).post(`/requests/${requestId}/restore`);
}

describe('restore round trip — endpoint + worker mark_restored', () => {
  it('seed watched+recycled → endpoint → worker callback → live with status preserved and no new guard_eval row', async () => {
    seedRecycledRow({ requestId: 'rt-watched', status: 'watched' });

    const guardEvalCountBefore = (db
      .prepare('SELECT COUNT(*) AS n FROM guard_eval')
      .get() as { n: number }).n;

    const resp = await postRestore('rt-watched');
    expect(resp.status).toBe(202);
    // jobId is restore-${requestId} so it can't collide with the still-retained
    // original download job (see router.test.ts regression test).
    expect(resp.body).toMatchObject({ requestId: 'rt-watched', jobId: 'restore-rt-watched' });

    // Endpoint enqueued the worker job with mode:restore — the real worker
    // would now download and post back. Simulate that callback.
    expect(downloadQueueAdd).toHaveBeenCalledTimes(1);
    expect(downloadQueueAdd.mock.calls[0]![1]).toMatchObject({
      requestId: 'rt-watched',
      url: 'https://www.youtube.com/watch?v=rt-watched',
      mode: 'restore',
    });
    expect(downloadQueueAdd.mock.calls[0]![2]).toEqual({ jobId: 'restore-rt-watched' });

    simulateWorkerRestoredCallback({
      requestId: 'rt-watched',
      filePath: FILE_PATH,
      nginxUrl: NGINX_URL,
      // The worker passes the fallback maxresdefault URL on every download,
      // so a non-null value is the realistic shape. mark_restored COALESCEs
      // it in — either the original editorial pick (preserved via the
      // separate "null preserves" property test) or the new fallback wins.
      thumbnailUrl: `https://i.ytimg.com/vi/rt-watched/maxresdefault.jpg`,
      fileSizeBytes: 234_567_890,
    });

    const row = db
      .prepare(
        `SELECT status, file_state, file_path, nginx_url, thumbnail_url,
                file_size_bytes, recycled_at
           FROM requests WHERE request_id = ?`,
      )
      .get('rt-watched') as {
        status: string; file_state: string;
        file_path: string | null; nginx_url: string | null;
        thumbnail_url: string | null; file_size_bytes: number | null;
        recycled_at: string | null;
      };

    // Acceptance criteria from the issue, asserted in one block:
    expect(row.status).toBe('watched');          // status unchanged across the round trip
    expect(row.file_state).toBe('live');         // file_state recycled → live
    expect(row.file_path).toBe(FILE_PATH);       // file_path re-populated
    expect(row.nginx_url).toBe(NGINX_URL);       // nginx_url re-populated
    expect(row.file_size_bytes).toBe(234_567_890); // file_size_bytes refreshed
    expect(row.recycled_at).toBeNull();          // recycled_at cleared
    expect(row.thumbnail_url).not.toBeNull();    // thumbnail re-populated (or preserved)

    // Guard not re-invoked on restore — guard_eval row count unchanged.
    const guardEvalCountAfter = (db
      .prepare('SELECT COUNT(*) AS n FROM guard_eval')
      .get() as { n: number }).n;
    expect(guardEvalCountAfter).toBe(guardEvalCountBefore);
  });

  it('seed ready+recycled → endpoint → worker callback → live, status stays ready', async () => {
    seedRecycledRow({ requestId: 'rt-ready', status: 'ready' });

    const resp = await postRestore('rt-ready');
    expect(resp.status).toBe(202);

    simulateWorkerRestoredCallback({
      requestId: 'rt-ready',
      filePath: FILE_PATH,
      nginxUrl: NGINX_URL,
      thumbnailUrl: null,
      fileSizeBytes: 1_000_000,
    });

    const row = db
      .prepare('SELECT status, file_state, recycled_at FROM requests WHERE request_id = ?')
      .get('rt-ready') as { status: string; file_state: string; recycled_at: string | null };
    expect(row.status).toBe('ready');
    expect(row.file_state).toBe('live');
    expect(row.recycled_at).toBeNull();
  });

  it('seed dismissed+recycled → endpoint → worker callback → live, status stays dismissed', async () => {
    seedRecycledRow({ requestId: 'rt-dismissed', status: 'dismissed' });

    const resp = await postRestore('rt-dismissed');
    expect(resp.status).toBe(202);

    simulateWorkerRestoredCallback({
      requestId: 'rt-dismissed',
      filePath: FILE_PATH,
      nginxUrl: NGINX_URL,
      thumbnailUrl: null,
      fileSizeBytes: 1_000_000,
    });

    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('rt-dismissed') as { status: string; file_state: string };
    expect(row.status).toBe('dismissed');
    expect(row.file_state).toBe('live');
  });
});
