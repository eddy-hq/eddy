import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    USER_ID_STEVE: '00000000-0000-7000-8000-000000000001',
  },
}));

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

const { getJobMock, addJobMock, removeJobMock, notifyMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addJobMock: vi.fn().mockResolvedValue(undefined),
  removeJobMock: vi.fn().mockResolvedValue(undefined),
  notifyMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../queue', () => ({
  downloadQueue: { getJob: getJobMock, add: addJobMock },
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: notifyMock }),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { checkStuckDownloads, isStuckBeyondGrace } from './index';

// Ages relative to the watchdog's windows: MIN_AGE_MS = 2 min (ignored younger),
// ESCALATION_AGE_MS = 15 min (give-up window).
const WITHIN_GRACE_MS = 10 * 60 * 1000; // visible to the watchdog, still inside the grace window → re-enqueue
const BEYOND_GRACE_MS = 20 * 60 * 1000; // past the give-up window → escalate

function insertStuckRequest(requestId: string, agoMs: number = WITHIN_GRACE_MS): void {
  db.prepare(`
    INSERT INTO requests (
      request_id, user_id, source, url, youtube_id, status, requested_at
    ) VALUES (?, ?, 'share_sheet', 'https://youtu.be/abc', 'abc', 'downloading', ?)
  `).run(requestId, 'user_1', new Date(Date.now() - agoMs).toISOString());
}

function jobInState(state: string): { id: string; getState: () => Promise<string>; remove: () => Promise<void> } {
  return {
    id: 'job_1',
    getState: vi.fn().mockResolvedValue(state),
    remove: removeJobMock,
  };
}

describe('isStuckBeyondGrace — pure, restart-proof predicate', () => {
  const NOW = Date.parse('2026-06-01T12:00:00.000Z');

  it('is false within the grace window', () => {
    expect(isStuckBeyondGrace(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW)).toBe(false);
  });

  it('is true once past the grace window', () => {
    expect(isStuckBeyondGrace(new Date(NOW - 20 * 60 * 1000).toISOString(), NOW)).toBe(true);
  });

  it('is true at exactly the 15-min boundary', () => {
    expect(isStuckBeyondGrace(new Date(NOW - 15 * 60 * 1000).toISOString(), NOW)).toBe(true);
  });

  it('escalates (true) on an unparseable timestamp rather than looping forever', () => {
    expect(isStuckBeyondGrace('not-a-date', NOW)).toBe(true);
  });

  it('depends only on its arguments — same answer every call, no accumulated state', () => {
    const ts = new Date(NOW - 20 * 60 * 1000).toISOString();
    // The pre-#184 bug was state that had to accumulate across calls. This
    // predicate gives the same verdict no matter how many times it is invoked.
    expect(isStuckBeyondGrace(ts, NOW)).toBe(true);
    expect(isStuckBeyondGrace(ts, NOW)).toBe(true);
    expect(isStuckBeyondGrace(ts, NOW)).toBe(true);
  });
});

describe('watchdog checkStuckDownloads', () => {
  beforeAll(async () => {
    await runMigrations();
    db.prepare(`INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('user_1', 'kid_1', 'kid', 'kid', new Date().toISOString());
  });

  beforeEach(() => {
    db.prepare('DELETE FROM requests').run();
    getJobMock.mockReset();
    addJobMock.mockClear();
    removeJobMock.mockClear();
    notifyMock.mockClear();
  });

  it('leaves jobs in `delayed` state alone — no re-enqueue, no alert', async () => {
    insertStuckRequest('req_delayed');
    getJobMock.mockResolvedValue(jobInState('delayed'));

    await checkStuckDownloads();

    expect(addJobMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('leaves jobs in `active` state alone — regression cover for the original behaviour', async () => {
    insertStuckRequest('req_active');
    getJobMock.mockResolvedValue(jobInState('active'));

    await checkStuckDownloads();

    expect(addJobMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'waiting-children', 'prioritized', 'paused'])(
    'leaves a job in `%s` state alone even past the grace window — a worker outage must not escalate a queued job',
    async (state) => {
      // Past the give-up window: if the healthy-state guard regressed, this row
      // would escalate to `failed` while a valid job still sits in the queue —
      // the orphan-file footgun the guard exists to prevent.
      insertStuckRequest(`req_${state}`, BEYOND_GRACE_MS);
      getJobMock.mockResolvedValue(jobInState(state));

      await checkStuckDownloads();

      expect(addJobMock).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get(`req_${state}`) as { status: string };
      expect(row.status).toBe('downloading');
    },
  );

  it('re-enqueues a `failed` job that is still inside the grace window, and alerts', async () => {
    insertStuckRequest('req_failed', WITHIN_GRACE_MS);
    getJobMock.mockResolvedValue(jobInState('failed'));

    await checkStuckDownloads();

    expect(addJobMock).toHaveBeenCalledTimes(1);
    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      expect.objectContaining({ requestId: 'req_failed' }),
      expect.objectContaining({ jobId: 'req_failed' }),
    );
    // Row stays `downloading` (re-enqueued, not escalated).
    const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req_failed') as { status: string };
    expect(row.status).toBe('downloading');
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'download_alert',
        requestId: 'req_failed',
        action: 're-enqueued',
      }),
      '00000000-0000-7000-8000-000000000001',
    );
  });

  describe('escalation is restart-proof (#184)', () => {
    it('escalates a row past the grace window on the FIRST cycle — no warm-up, no accumulated counter', async () => {
      // A freshly-restarted process has no in-memory history. The pre-#184 code
      // re-enqueued on cycle 1 (counter 0→1) and only gave up on ~cycle 4, so a
      // server that restarted every few minutes never reached escalation and
      // re-enqueued the same stuck row forever. Time-based escalation fires on
      // the very first cycle because the verdict reads only `requested_at`.
      insertStuckRequest('req_old', BEYOND_GRACE_MS);
      getJobMock.mockResolvedValue(jobInState('failed'));

      await checkStuckDownloads(); // the very first cycle after a (simulated) restart

      // Did NOT re-enqueue — escalated instead.
      expect(addJobMock).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req_old') as { status: string };
      expect(row.status).toBe('failed');
      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'failed', requestId: 'req_old' }),
        '00000000-0000-7000-8000-000000000001',
      );
    });

    it('escalates a missing job (vanished from Redis) once past the grace window', async () => {
      // The job was evicted (removeOnFail) or Redis was flushed — getJob returns
      // null. An old row with no recoverable job must terminate, not spin.
      insertStuckRequest('req_gone', BEYOND_GRACE_MS);
      getJobMock.mockResolvedValue(null);

      await checkStuckDownloads();

      expect(addJobMock).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req_gone') as { status: string };
      expect(row.status).toBe('failed');
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'failed', requestId: 'req_gone' }),
        '00000000-0000-7000-8000-000000000001',
      );
    });

    it('escalation no-ops without alerting if the row already left `downloading`', async () => {
      // mark_failed gates on `status = 'downloading'`; a concurrent worker
      // callback that already moved the row must not draw a stale "failed" alert.
      insertStuckRequest('req_raced', BEYOND_GRACE_MS);
      getJobMock.mockResolvedValue(jobInState('failed'));
      db.prepare(`UPDATE requests SET status = 'ready' WHERE request_id = ?`).run('req_raced');

      await checkStuckDownloads();

      expect(notifyMock).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req_raced') as { status: string };
      expect(row.status).toBe('ready');
    });
  });
});
