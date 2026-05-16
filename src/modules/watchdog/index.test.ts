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
import { checkStuckDownloads, resetWatchdogStateForTests } from './index';

const STUCK_AGO_MS = 10 * 60 * 1000; // older than the watchdog's 2-min MIN_AGE_MS

function insertStuckRequest(requestId: string): void {
  db.prepare(`
    INSERT INTO requests (
      request_id, user_id, source, url, youtube_id, status, requested_at
    ) VALUES (?, ?, 'share_sheet', 'https://youtu.be/abc', 'abc', 'downloading', ?)
  `).run(requestId, 'user_1', new Date(Date.now() - STUCK_AGO_MS).toISOString());
}

function jobInState(state: string): { id: string; getState: () => Promise<string>; remove: () => Promise<void> } {
  return {
    id: 'job_1',
    getState: vi.fn().mockResolvedValue(state),
    remove: removeJobMock,
  };
}

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
    'leaves jobs in `%s` state alone — healthy-pending, must not count toward escalation',
    async (state) => {
      resetWatchdogStateForTests();
      insertStuckRequest(`req_${state}`);
      getJobMock.mockResolvedValue(jobInState(state));

      // Drive past the escalation threshold; a healthy-pending job must never
      // tip the watchdog into marking the row `failed`.
      for (let i = 0; i < 5; i++) await checkStuckDownloads();

      expect(addJobMock).not.toHaveBeenCalled();
      expect(notifyMock).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get(`req_${state}`) as { status: string };
      expect(row.status).toBe('downloading');
    },
  );

  it('re-enqueues a `failed` job and alerts', async () => {
    insertStuckRequest('req_failed');
    getJobMock.mockResolvedValue(jobInState('failed'));

    await checkStuckDownloads();

    expect(addJobMock).toHaveBeenCalledTimes(1);
    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      expect.objectContaining({ requestId: 'req_failed' }),
      expect.objectContaining({ jobId: 'req_failed' }),
    );
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

  describe('escalation after repeated re-enqueues', () => {
    beforeEach(() => {
      resetWatchdogStateForTests();
    });

    it('escalates to failed after the re-enqueue threshold is exceeded', async () => {
      insertStuckRequest('req_loop');
      getJobMock.mockResolvedValue(jobInState('failed'));

      // 3 re-enqueue cycles — the threshold — should all pass through normally.
      for (let i = 0; i < 3; i++) await checkStuckDownloads();
      expect(addJobMock).toHaveBeenCalledTimes(3);
      expect(notifyMock).toHaveBeenCalledTimes(3);
      for (const call of notifyMock.mock.calls) {
        expect(call[0]).toMatchObject({ action: 're-enqueued' });
      }

      // 4th cycle — over threshold — should escalate, not re-enqueue.
      await checkStuckDownloads();
      expect(addJobMock).toHaveBeenCalledTimes(3); // unchanged
      expect(notifyMock).toHaveBeenCalledTimes(4);
      expect(notifyMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'failed', requestId: 'req_loop' }),
        '00000000-0000-7000-8000-000000000001',
      );

      const row = db.prepare('SELECT status FROM requests WHERE request_id = ?').get('req_loop') as { status: string };
      expect(row.status).toBe('failed');
    });

    it('resets the counter when a request leaves `downloading` between cycles', async () => {
      insertStuckRequest('req_recovers');
      getJobMock.mockResolvedValue(jobInState('failed'));

      // Two re-enqueues — build up some counter state.
      await checkStuckDownloads();
      await checkStuckDownloads();
      expect(addJobMock).toHaveBeenCalledTimes(2);

      // Simulate the worker succeeding: row moves to `ready` (or anywhere out
      // of `downloading`).
      db.prepare(`UPDATE requests SET status = 'ready' WHERE request_id = ?`).run('req_recovers');

      // Next cycle clears the counter (request no longer stuck).
      await checkStuckDownloads();

      // Row goes back to `downloading` (manual retry, watchdog can't tell).
      // The escalation grace window should reset: 3 fresh re-enqueues, no escalation.
      db.prepare(`UPDATE requests SET status = 'downloading' WHERE request_id = ?`).run('req_recovers');
      addJobMock.mockClear();
      notifyMock.mockClear();

      for (let i = 0; i < 3; i++) await checkStuckDownloads();
      expect(addJobMock).toHaveBeenCalledTimes(3);
      for (const call of notifyMock.mock.calls) {
        expect(call[0]).toMatchObject({ action: 're-enqueued' });
      }
    });
  });
});
