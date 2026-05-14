import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: {},
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

const { getJobMock, addJobMock, removeJobMock, sendAlertMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addJobMock: vi.fn().mockResolvedValue(undefined),
  removeJobMock: vi.fn().mockResolvedValue(undefined),
  sendAlertMock: vi.fn(),
}));

vi.mock('../../queue', () => ({
  downloadQueue: { getJob: getJobMock, add: addJobMock },
}));

vi.mock('../notifications', () => ({
  sendDownloadAlert: sendAlertMock,
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { checkStuckDownloads } from './index';

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
    sendAlertMock.mockClear();
  });

  it('leaves jobs in `delayed` state alone — no re-enqueue, no alert', async () => {
    insertStuckRequest('req_delayed');
    getJobMock.mockResolvedValue(jobInState('delayed'));

    await checkStuckDownloads();

    expect(addJobMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('leaves jobs in `active` state alone — regression cover for the original behaviour', async () => {
    insertStuckRequest('req_active');
    getJobMock.mockResolvedValue(jobInState('active'));

    await checkStuckDownloads();

    expect(addJobMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

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
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req_failed', action: 're-enqueued' }),
    );
  });
});
