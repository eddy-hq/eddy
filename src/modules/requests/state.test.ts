import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { removeJobMock, getJobMock, addJobMock, deleteAddJobMock, redisDelMock } = vi.hoisted(() => ({
  removeJobMock: vi.fn().mockResolvedValue(undefined),
  getJobMock: vi.fn(),
  addJobMock: vi.fn().mockResolvedValue(undefined),
  deleteAddJobMock: vi.fn().mockResolvedValue(undefined),
  redisDelMock: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../queue', () => ({
  redis: { del: redisDelMock },
  downloadQueue: { getJob: getJobMock, add: addJobMock },
  deleteQueue: { add: deleteAddJobMock },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
  closeQueues: vi.fn(),
}));

vi.mock('../notifications', () => ({
  sendVideoReady: vi.fn().mockResolvedValue(undefined),
  sendDownloadAlert: vi.fn(),
  sendParentReview: vi.fn(),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

const { ensurePersonForChannelMock, applyChannelInfoToPersonMock } = vi.hoisted(() => ({
  ensurePersonForChannelMock: vi.fn(),
  applyChannelInfoToPersonMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../people', () => ({
  ensurePersonForChannel: ensurePersonForChannelMock,
  applyChannelInfoToPerson: applyChannelInfoToPersonMock,
}));

import { db } from '../../db/client';
import { logger } from '../../logger';
import { runMigrations } from '../../db/migrate';
import { sendVideoReady } from '../notifications';
import {
  markWatched,
  markDismissed,
  markCancelled,
  markSoftDeleted,
  markDownloaded,
  markRejected,
  markGuardBlocked,
  markFailed,
  retry,
  createFromShareSheet,
  createFromChannelPoll,
  createFromCandidate,
  findActiveDuplicateRequest,
  CANCELLED_REASON,
  type DownloadedFields,
  type Status,
} from './state';

const USER_ID = '11111111-1111-7111-8111-111111111111';

function insertRequest(opts: {
  request_id: string;
  status: Status;
  watched_at?: string | null;
  file_path?: string | null;
  youtube_id?: string | null;
  url?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, status, file_path, requested_at, added_at, watched_at)
     VALUES (?, ?, 'share_sheet', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.request_id,
    USER_ID,
    opts.url ?? 'https://www.youtube.com/watch?v=abc',
    opts.youtube_id ?? null,
    opts.status,
    opts.file_path ?? null,
    now,
    now,
    opts.watched_at ?? null,
  );
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  getJobMock.mockReset();
  removeJobMock.mockClear();
  addJobMock.mockReset();
  addJobMock.mockResolvedValue(undefined);
  deleteAddJobMock.mockReset();
  deleteAddJobMock.mockResolvedValue(undefined);
  redisDelMock.mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(sendVideoReady).mockReset();
  vi.mocked(sendVideoReady).mockResolvedValue(undefined);
  ensurePersonForChannelMock.mockReset();
  ensurePersonForChannelMock.mockReturnValue({ personId: 'person-stub', outputId: 'output-stub' });
  applyChannelInfoToPersonMock.mockReset();
  applyChannelInfoToPersonMock.mockResolvedValue(undefined);
});

describe('markWatched', () => {
  it('transitions ready → watched and returns the user_id', () => {
    insertRequest({ request_id: 'req-1', status: 'ready' });

    const result = markWatched('req-1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
  });

  it('sets watched_at on the row when the transition succeeds', () => {
    insertRequest({ request_id: 'req-2', status: 'ready' });
    const before = Date.now();

    markWatched('req-2');

    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-2') as { status: string; watched_at: string | null };
    expect(row.status).toBe('watched');
    expect(row.watched_at).not.toBeNull();
    expect(new Date(row.watched_at!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('is a no-op on an already-watched row', () => {
    const originalWatchedAt = '2026-01-01T00:00:00.000Z';
    insertRequest({ request_id: 'req-3', status: 'watched', watched_at: originalWatchedAt });

    const result = markWatched('req-3');

    expect(result).toEqual({ transitioned: false, currentStatus: 'watched' });
    const row = db
      .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
      .get('req-3') as { watched_at: string };
    expect(row.watched_at).toBe(originalWatchedAt);
  });

  it('is a no-op on a rejected row', () => {
    insertRequest({ request_id: 'req-4', status: 'rejected' });

    const result = markWatched('req-4');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-4') as { status: string; watched_at: string | null };
    expect(row.status).toBe('rejected');
    expect(row.watched_at).toBeNull();
  });
});

describe('markDismissed', () => {
  it('transitions ready → dismissed and returns the user_id', () => {
    insertRequest({ request_id: 'req-d1', status: 'ready' });

    const result = markDismissed('req-d1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-d1') as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('is a no-op on a downloading row and does not change status', () => {
    insertRequest({ request_id: 'req-d2', status: 'downloading' });

    const result = markDismissed('req-d2');

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-d2') as { status: string };
    expect(row.status).toBe('downloading');
  });

  it('returns currentStatus: null for an unknown id', () => {
    const result = markDismissed('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('markCancelled', () => {
  it('transitions downloading → rejected with sentinel reason and removes job', async () => {
    insertRequest({ request_id: 'req-c1', status: 'downloading' });
    getJobMock.mockResolvedValueOnce({ remove: removeJobMock });

    const result = markCancelled('req-c1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, rejection_reason FROM requests WHERE request_id = ?')
      .get('req-c1') as { status: string; rejection_reason: string };
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe(CANCELLED_REASON);

    expect(getJobMock).toHaveBeenCalledWith('req-c1');
    expect(redisDelMock).toHaveBeenCalledWith('eddy:progress:req-c1');

    // Let the fire-and-forget chain settle so we can assert remove() ran.
    await new Promise((resolve) => setImmediate(resolve));
    expect(removeJobMock).toHaveBeenCalled();
  });

  it('is a no-op on an already-rejected row and does not call queue or redis', () => {
    insertRequest({ request_id: 'req-c2', status: 'rejected' });

    const result = markCancelled('req-c2');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not call queue', () => {
    const result = markCancelled('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
  });
});

describe('markSoftDeleted', () => {
  const FILE_PATH = '/mnt/ssd/eddy/videos/abc123.mp4';

  it('transitions ready → deleted, sets columns, and enqueues a delete job', async () => {
    insertRequest({ request_id: 'req-s1', status: 'ready', file_path: FILE_PATH });
    const before = Date.now();

    const result = markSoftDeleted('req-s1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, file_state, deleted_at FROM requests WHERE request_id = ?')
      .get('req-s1') as { status: string; file_state: string; deleted_at: string | null };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');
    expect(row.deleted_at).not.toBeNull();
    expect(new Date(row.deleted_at!).getTime()).toBeGreaterThanOrEqual(before);

    // The unlink itself runs on the Ubuntu worker — the M4 just enqueues the job.
    expect(deleteAddJobMock).toHaveBeenCalledWith(
      'delete',
      { requestId: 'req-s1', filePath: FILE_PATH },
      { jobId: 'delete:req-s1' },
    );
  });

  it('transitions watched → deleted and enqueues a delete job', () => {
    insertRequest({ request_id: 'req-s2', status: 'watched', file_path: FILE_PATH });

    const result = markSoftDeleted('req-s2');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s2') as { status: string; file_state: string };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');

    expect(deleteAddJobMock).toHaveBeenCalledWith(
      'delete',
      { requestId: 'req-s2', filePath: FILE_PATH },
      { jobId: 'delete:req-s2' },
    );
  });

  it('is a no-op on a downloading row and does not enqueue', () => {
    insertRequest({ request_id: 'req-s3', status: 'downloading', file_path: FILE_PATH });

    const result = markSoftDeleted('req-s3');

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s3') as { status: string; file_state: string };
    expect(row.status).toBe('downloading');
    expect(row.file_state).toBe('live');
    expect(deleteAddJobMock).not.toHaveBeenCalled();
  });

  it('is a no-op on a rejected row and does not enqueue', () => {
    insertRequest({ request_id: 'req-s4', status: 'rejected', file_path: FILE_PATH });

    const result = markSoftDeleted('req-s4');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(deleteAddJobMock).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not enqueue', () => {
    const result = markSoftDeleted('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(deleteAddJobMock).not.toHaveBeenCalled();
  });

  it('does not enqueue when the row has no file_path', () => {
    insertRequest({ request_id: 'req-s5', status: 'ready', file_path: null });

    const result = markSoftDeleted('req-s5');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(deleteAddJobMock).not.toHaveBeenCalled();
  });

  it('warn-logs but still marks deleted when the queue enqueue throws', async () => {
    insertRequest({ request_id: 'req-s6', status: 'ready', file_path: FILE_PATH });
    deleteAddJobMock.mockRejectedValueOnce(new Error('redis down'));

    const result = markSoftDeleted('req-s6');
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    // Let the rejected fire-and-forget settle.
    await new Promise((resolve) => setImmediate(resolve));

    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s6') as { status: string; file_state: string };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ requestId: 'req-s6' });
  });
});

describe('markDownloaded', () => {
  const FIELDS: DownloadedFields = {
    title: 'A grand title',
    channel: 'Channel One',
    youtubeChannelId: 'UCabc123channel',
    description: 'A description',
    durationSecs: 123,
    transcript: 'transcript text',
    filePath: '/videos/abc123.mp4',
    nginxUrl: 'https://m4.local/videos/abc123.mp4',
    thumbnailUrl: 'https://m4.local/videos/abc123.jpg',
  };

  it('transitions downloading → ready, writes all fields, and fires sendVideoReady', () => {
    insertRequest({ request_id: 'req-dl1', status: 'downloading' });
    const before = Date.now();

    const result = markDownloaded('req-dl1', FIELDS);

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare(
        `SELECT status, title, channel, youtube_channel_id, description, duration_secs, transcript,
                file_path, nginx_url, thumbnail_url, downloaded_at
         FROM requests WHERE request_id = ?`,
      )
      .get('req-dl1') as {
        status: string; title: string; channel: string; youtube_channel_id: string;
        description: string;
        duration_secs: number; transcript: string; file_path: string;
        nginx_url: string; thumbnail_url: string; downloaded_at: string;
      };
    expect(row.status).toBe('ready');
    expect(row.title).toBe(FIELDS.title);
    expect(row.channel).toBe(FIELDS.channel);
    expect(row.youtube_channel_id).toBe(FIELDS.youtubeChannelId);
    expect(row.description).toBe(FIELDS.description);
    expect(row.duration_secs).toBe(FIELDS.durationSecs);
    expect(row.transcript).toBe(FIELDS.transcript);
    expect(row.file_path).toBe(FIELDS.filePath);
    expect(row.nginx_url).toBe(FIELDS.nginxUrl);
    expect(row.thumbnail_url).toBe(FIELDS.thumbnailUrl);
    expect(new Date(row.downloaded_at).getTime()).toBeGreaterThanOrEqual(before);

    expect(vi.mocked(sendVideoReady)).toHaveBeenCalledWith(USER_ID, 'req-dl1', FIELDS.title);
  });

  it('is a no-op on an already-rejected row and does not fire the notification', () => {
    insertRequest({ request_id: 'req-dl2', status: 'rejected' });

    const result = markDownloaded('req-dl2', FIELDS);

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT status, title FROM requests WHERE request_id = ?')
      .get('req-dl2') as { status: string; title: string | null };
    expect(row.status).toBe('rejected');
    expect(row.title).toBeNull();
    expect(vi.mocked(sendVideoReady)).not.toHaveBeenCalled();
  });

  it('is a no-op on an already-ready row and does not re-fire the notification', () => {
    insertRequest({ request_id: 'req-dl3', status: 'ready' });

    const result = markDownloaded('req-dl3', FIELDS);

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
    expect(vi.mocked(sendVideoReady)).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not fire the notification', () => {
    const result = markDownloaded('does-not-exist', FIELDS);

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(vi.mocked(sendVideoReady)).not.toHaveBeenCalled();
  });

  it('warn-logs when sendVideoReady rejects and does not surface as unhandled rejection', async () => {
    insertRequest({ request_id: 'req-dl4', status: 'downloading' });
    vi.mocked(sendVideoReady).mockRejectedValueOnce(new Error('ntfy down'));

    const result = markDownloaded('req-dl4', FIELDS);
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    // Let the rejected fire-and-forget settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ requestId: 'req-dl4', userId: USER_ID });
  });

  it('triggers person capture when channelId is present', () => {
    insertRequest({ request_id: 'req-dl-pc1', status: 'downloading' });

    const result = markDownloaded('req-dl-pc1', FIELDS);

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(ensurePersonForChannelMock).toHaveBeenCalledWith(FIELDS.youtubeChannelId, FIELDS.channel);
    expect(applyChannelInfoToPersonMock).toHaveBeenCalledWith('person-stub', FIELDS.youtubeChannelId);
  });

  it('skips person capture when channelId is null', () => {
    insertRequest({ request_id: 'req-dl-pc2', status: 'downloading' });

    const result = markDownloaded('req-dl-pc2', { ...FIELDS, youtubeChannelId: null });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(ensurePersonForChannelMock).not.toHaveBeenCalled();
    expect(applyChannelInfoToPersonMock).not.toHaveBeenCalled();
  });

  it('does not trigger person capture when transition is a no-op', () => {
    insertRequest({ request_id: 'req-dl-pc3', status: 'ready' });

    const result = markDownloaded('req-dl-pc3', FIELDS);

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
    expect(ensurePersonForChannelMock).not.toHaveBeenCalled();
    expect(applyChannelInfoToPersonMock).not.toHaveBeenCalled();
  });

  it('warn-logs when ensurePersonForChannel throws and still returns transitioned: true', () => {
    insertRequest({ request_id: 'req-dl-pc4', status: 'downloading' });
    ensurePersonForChannelMock.mockImplementationOnce(() => {
      throw new Error('db locked');
    });

    const result = markDownloaded('req-dl-pc4', FIELDS);

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(applyChannelInfoToPersonMock).not.toHaveBeenCalled();
    // sendVideoReady fires first, then the channel-capture warn — assert that
    // at least one warn carries the channelId metadata so we know the catch
    // branch ran.
    const warns = vi.mocked(logger.warn).mock.calls;
    const captureWarn = warns.find(([meta]) => (meta as { channelId?: string }).channelId === FIELDS.youtubeChannelId);
    expect(captureWarn).toBeDefined();
  });

  it('swallows applyChannelInfoToPerson rejection (fire-and-forget) and does not surface as unhandled', async () => {
    insertRequest({ request_id: 'req-dl-pc5', status: 'downloading' });
    applyChannelInfoToPersonMock.mockRejectedValueOnce(new Error('yt-dlp flake'));

    const result = markDownloaded('req-dl-pc5', FIELDS);
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    // Let the rejected fire-and-forget settle.
    await new Promise((resolve) => setImmediate(resolve));

    // Debug-logged, not warned — matches the channel-poll path's noise level.
    expect(vi.mocked(logger.debug)).toHaveBeenCalled();
  });
});

describe('markRejected', () => {
  it('transitions downloading → rejected and writes the reason', () => {
    insertRequest({ request_id: 'req-rj1', status: 'downloading' });

    const result = markRejected('req-rj1', 'yt-dlp 403');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, rejection_reason FROM requests WHERE request_id = ?')
      .get('req-rj1') as { status: string; rejection_reason: string };
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('yt-dlp 403');
  });

  it('is a no-op on an already-rejected row and does not overwrite the reason', () => {
    insertRequest({ request_id: 'req-rj2', status: 'rejected' });
    db.prepare('UPDATE requests SET rejection_reason = ? WHERE request_id = ?')
      .run('original reason', 'req-rj2');

    const result = markRejected('req-rj2', 'new reason');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT rejection_reason FROM requests WHERE request_id = ?')
      .get('req-rj2') as { rejection_reason: string };
    expect(row.rejection_reason).toBe('original reason');
  });

  it('is a no-op on a non-downloading source (e.g. ready)', () => {
    insertRequest({ request_id: 'req-rj3', status: 'ready' });

    const result = markRejected('req-rj3', 'too late');

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
  });

  it('returns currentStatus: null for an unknown id', () => {
    const result = markRejected('does-not-exist', 'reason');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('markGuardBlocked', () => {
  it('transitions downloading → rejected with reason — same SQL as markRejected', () => {
    insertRequest({ request_id: 'req-gb1', status: 'downloading' });

    const result = markGuardBlocked('req-gb1', 'unsafe content');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, rejection_reason FROM requests WHERE request_id = ?')
      .get('req-gb1') as { status: string; rejection_reason: string };
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('unsafe content');
  });

  it('is a no-op on a non-downloading source', () => {
    insertRequest({ request_id: 'req-gb2', status: 'rejected' });

    const result = markGuardBlocked('req-gb2', 'unsafe content');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
  });

  it('returns currentStatus: null for an unknown id', () => {
    const result = markGuardBlocked('does-not-exist', 'unsafe');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('markFailed', () => {
  it('transitions downloading → failed', () => {
    insertRequest({ request_id: 'req-f1', status: 'downloading' });

    const result = markFailed('req-f1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-f1') as { status: string };
    expect(row.status).toBe('failed');
  });

  it('is a no-op on a ready row and does not change status', () => {
    insertRequest({ request_id: 'req-f2', status: 'ready' });

    const result = markFailed('req-f2');

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-f2') as { status: string };
    expect(row.status).toBe('ready');
  });

  it('returns currentStatus: null for an unknown id', () => {
    const result = markFailed('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('retry', () => {
  const URL = 'https://www.youtube.com/watch?v=zzz';
  const YT_ID = 'zzz12345xyz';

  it('transitions failed → downloading, removes existing job, and re-adds with stored youtube_id and url', async () => {
    insertRequest({ request_id: 'req-r1', status: 'failed', youtube_id: YT_ID, url: URL });
    getJobMock.mockResolvedValueOnce({ remove: removeJobMock });

    const result = await retry('req-r1');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-r1') as { status: string };
    expect(row.status).toBe('downloading');

    expect(getJobMock).toHaveBeenCalledWith('req-r1');
    expect(removeJobMock).toHaveBeenCalledTimes(1);
    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId: 'req-r1', youtubeId: YT_ID, url: URL },
      { jobId: 'req-r1' },
    );
  });

  it('transitions downloading → downloading (idempotent re-enqueue) — same removeJob + add', async () => {
    insertRequest({ request_id: 'req-r2', status: 'downloading', youtube_id: YT_ID, url: URL });
    getJobMock.mockResolvedValueOnce({ remove: removeJobMock });

    const result = await retry('req-r2');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-r2') as { status: string };
    expect(row.status).toBe('downloading');

    expect(removeJobMock).toHaveBeenCalledTimes(1);
    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId: 'req-r2', youtubeId: YT_ID, url: URL },
      { jobId: 'req-r2' },
    );
  });

  it('is a no-op on a rejected row and does not touch the queue', async () => {
    insertRequest({ request_id: 'req-r3', status: 'rejected' });

    const result = await retry('req-r3');

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not touch the queue', async () => {
    const result = await retry('does-not-exist');

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(getJobMock).not.toHaveBeenCalled();
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('logs-warned but still re-adds when removing the existing job throws', async () => {
    insertRequest({ request_id: 'req-r4', status: 'failed', youtube_id: YT_ID, url: URL });
    getJobMock.mockRejectedValueOnce(new Error('redis down'));

    const result = await retry('req-r4');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(addJobMock).toHaveBeenCalledTimes(1);
  });

  it('logs-warned and does not throw when adding the new job fails', async () => {
    insertRequest({ request_id: 'req-r5', status: 'failed', youtube_id: YT_ID, url: URL });
    getJobMock.mockResolvedValueOnce(null);
    addJobMock.mockRejectedValueOnce(new Error('redis down'));

    const result = await retry('req-r5');

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('passes empty string when youtube_id is null on the row', async () => {
    insertRequest({ request_id: 'req-r6', status: 'failed', youtube_id: null, url: URL });
    getJobMock.mockResolvedValueOnce(null);

    await retry('req-r6');

    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId: 'req-r6', youtubeId: '', url: URL },
      { jobId: 'req-r6' },
    );
  });
});

describe('createFromShareSheet', () => {
  const URL = 'https://www.youtube.com/watch?v=abc';
  const YT_ID = 'abc12345xyz';

  it('inserts a downloading share_sheet row with auto decision and enqueues with the new id', async () => {
    const before = Date.now();

    const { requestId } = await createFromShareSheet({
      url: URL,
      userId: USER_ID,
      youtubeId: YT_ID,
    });

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);

    const row = db
      .prepare(
        `SELECT user_id, source, url, youtube_id, status, decided_by, decided_at, requested_at, added_at
           FROM requests WHERE request_id = ?`,
      )
      .get(requestId) as {
        user_id: string; source: string; url: string; youtube_id: string;
        status: string; decided_by: string; decided_at: string;
        requested_at: string; added_at: string;
      };
    expect(row.user_id).toBe(USER_ID);
    expect(row.source).toBe('share_sheet');
    expect(row.url).toBe(URL);
    expect(row.youtube_id).toBe(YT_ID);
    expect(row.status).toBe('downloading');
    expect(row.decided_by).toBe('auto');
    expect(new Date(row.decided_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(row.requested_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(row.added_at).getTime()).toBeGreaterThanOrEqual(before);

    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId, youtubeId: YT_ID, url: URL },
      { jobId: requestId },
    );
  });

  it('passes empty string youtubeId to queue when caller omits it', async () => {
    const { requestId } = await createFromShareSheet({ url: URL, userId: USER_ID });

    const row = db
      .prepare('SELECT youtube_id FROM requests WHERE request_id = ?')
      .get(requestId) as { youtube_id: string | null };
    expect(row.youtube_id).toBeNull();

    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId, youtubeId: '', url: URL },
      { jobId: requestId },
    );
  });

  it('leaves the row in place and warn-logs when queue add throws', async () => {
    addJobMock.mockRejectedValueOnce(new Error('redis down'));

    const { requestId } = await createFromShareSheet({
      url: URL,
      userId: USER_ID,
      youtubeId: YT_ID,
    });

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string };
    expect(row.status).toBe('downloading');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ requestId });
  });
});

describe('createFromChannelPoll', () => {
  const URL = 'https://www.youtube.com/watch?v=poll1';
  const YT_ID = 'poll1xxxxxx';
  const CHANNEL_ID = 'UCpoll1xxxxxxxxxxxxxxxxx';
  const TITLE = 'Episode 42';
  const CHANNEL = 'A Followed Creator';

  it('inserts a downloading channel_subscription row with title/channel/youtube_channel_id/file_state=live and no decided_by', async () => {
    const before = Date.now();

    const { requestId } = await createFromChannelPoll({
      url: URL,
      userId: USER_ID,
      youtubeId: YT_ID,
      youtubeChannelId: CHANNEL_ID,
      title: TITLE,
      channel: CHANNEL,
    });

    const row = db
      .prepare(
        `SELECT source, url, youtube_id, youtube_channel_id, title, channel, status, file_state,
                decided_by, decided_at, requested_at, added_at
           FROM requests WHERE request_id = ?`,
      )
      .get(requestId) as {
        source: string; url: string; youtube_id: string;
        youtube_channel_id: string;
        title: string;
        channel: string; status: string; file_state: string;
        decided_by: string | null; decided_at: string | null;
        requested_at: string; added_at: string;
      };
    expect(row.source).toBe('channel_subscription');
    expect(row.url).toBe(URL);
    expect(row.youtube_id).toBe(YT_ID);
    expect(row.youtube_channel_id).toBe(CHANNEL_ID);
    expect(row.title).toBe(TITLE);
    expect(row.channel).toBe(CHANNEL);
    expect(row.status).toBe('downloading');
    expect(row.file_state).toBe('live');
    expect(row.decided_by).toBeNull();
    expect(row.decided_at).toBeNull();
    expect(new Date(row.requested_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(row.added_at).getTime()).toBeGreaterThanOrEqual(before);

    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId, youtubeId: YT_ID, url: URL },
      { jobId: requestId },
    );
  });

  it('leaves the row in place and warn-logs when queue add throws', async () => {
    addJobMock.mockRejectedValueOnce(new Error('redis down'));

    const { requestId } = await createFromChannelPoll({
      url: URL,
      userId: USER_ID,
      youtubeId: YT_ID,
      youtubeChannelId: CHANNEL_ID,
      title: TITLE,
      channel: CHANNEL,
    });

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string };
    expect(row.status).toBe('downloading');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

describe('createFromCandidate', () => {
  const URL = 'https://www.youtube.com/watch?v=cand1';
  const YT_ID = 'cand1xxxxxx';
  const TITLE = 'A picked-for-you title';

  it('inserts a downloading recommended row with title and auto decision', async () => {
    const before = Date.now();

    const { requestId } = await createFromCandidate({
      url: URL,
      userId: USER_ID,
      youtubeId: YT_ID,
      title: TITLE,
    });

    const row = db
      .prepare(
        `SELECT source, url, youtube_id, title, status, decided_by, decided_at, requested_at
           FROM requests WHERE request_id = ?`,
      )
      .get(requestId) as {
        source: string; url: string; youtube_id: string; title: string;
        status: string; decided_by: string; decided_at: string; requested_at: string;
      };
    expect(row.source).toBe('recommended');
    expect(row.url).toBe(URL);
    expect(row.youtube_id).toBe(YT_ID);
    expect(row.title).toBe(TITLE);
    expect(row.status).toBe('downloading');
    expect(row.decided_by).toBe('auto');
    expect(new Date(row.decided_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(row.requested_at).getTime()).toBeGreaterThanOrEqual(before);

    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId, youtubeId: YT_ID, url: URL },
      { jobId: requestId },
    );
  });

  it('passes empty string youtubeId to queue when external_id is null', async () => {
    const { requestId } = await createFromCandidate({
      url: URL,
      userId: USER_ID,
      youtubeId: null,
      title: TITLE,
    });

    expect(addJobMock).toHaveBeenCalledWith(
      'download',
      { requestId, youtubeId: '', url: URL },
      { jobId: requestId },
    );
  });

  it('leaves the row in place and warn-logs when queue add throws', async () => {
    addJobMock.mockRejectedValueOnce(new Error('redis down'));

    const { requestId } = await createFromCandidate({
      url: URL,
      userId: USER_ID,
      youtubeId: YT_ID,
      title: TITLE,
    });

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string };
    expect(row.status).toBe('downloading');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

describe('findActiveDuplicateRequest', () => {
  const YT_ID = 'dedup12345x';

  it('returns the row for an active downloading request', () => {
    insertRequest({ request_id: 'req-dup1', status: 'downloading', youtube_id: YT_ID });

    const result = findActiveDuplicateRequest(USER_ID, YT_ID);

    expect(result).toEqual({ requestId: 'req-dup1', status: 'downloading' });
  });

  it('returns the row for a ready request', () => {
    insertRequest({ request_id: 'req-dup2', status: 'ready', youtube_id: YT_ID });

    const result = findActiveDuplicateRequest(USER_ID, YT_ID);

    expect(result).toEqual({ requestId: 'req-dup2', status: 'ready' });
  });

  // The bug from #36: a soft-deleted row used to dedup against fresh requests,
  // making re-requests after delete silently no-op.
  it('returns null when the only matching row is soft-deleted', () => {
    insertRequest({ request_id: 'req-dup3', status: 'deleted', youtube_id: YT_ID });

    const result = findActiveDuplicateRequest(USER_ID, YT_ID);

    expect(result).toBeNull();
  });

  it('returns null when the only matching rows are rejected / dismissed / watched', () => {
    insertRequest({ request_id: 'req-dup4a', status: 'rejected', youtube_id: YT_ID });
    insertRequest({ request_id: 'req-dup4b', status: 'dismissed', youtube_id: 'other-id-1' });
    insertRequest({ request_id: 'req-dup4c', status: 'watched', youtube_id: 'other-id-2' });

    expect(findActiveDuplicateRequest(USER_ID, YT_ID)).toBeNull();
    expect(findActiveDuplicateRequest(USER_ID, 'other-id-1')).toBeNull();
    expect(findActiveDuplicateRequest(USER_ID, 'other-id-2')).toBeNull();
  });

  it('prefers the most recent live row when an older deleted row also matches', () => {
    db.prepare(
      `INSERT INTO requests
         (request_id, user_id, source, url, youtube_id, status, requested_at, added_at)
       VALUES (?, ?, 'share_sheet', ?, ?, ?, ?, ?)`,
    ).run(
      'req-dup5-old',
      USER_ID,
      'https://www.youtube.com/watch?v=dedup',
      YT_ID,
      'deleted',
      '2026-04-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO requests
         (request_id, user_id, source, url, youtube_id, status, requested_at, added_at)
       VALUES (?, ?, 'share_sheet', ?, ?, ?, ?, ?)`,
    ).run(
      'req-dup5-new',
      USER_ID,
      'https://www.youtube.com/watch?v=dedup',
      YT_ID,
      'downloading',
      '2026-04-26T00:00:00.000Z',
      '2026-04-26T00:00:00.000Z',
    );

    const result = findActiveDuplicateRequest(USER_ID, YT_ID);

    expect(result).toEqual({ requestId: 'req-dup5-new', status: 'downloading' });
  });

  it('returns null when nothing matches the user / youtube_id', () => {
    insertRequest({ request_id: 'req-dup6', status: 'ready', youtube_id: 'different' });

    const result = findActiveDuplicateRequest(USER_ID, YT_ID);

    expect(result).toBeNull();
  });
});
