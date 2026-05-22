import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The `:memory:` DB is a fast test fixture, not a port — it stays mocked so
// the suite never touches the on-disk file. Every other side-effect dependency
// (queue, notifications, people/registry) goes through the `Ports` seam and is
// passed in as a fake at test time. The logger mock stays because the
// transition effects log on failure paths and we assert against those log calls.
vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { logger } from '../../logger';
import { runMigrations } from '../../db/migrate';
import {
  createRequestsState,
  findActiveDuplicateRequest,
  CANCELLED_REASON,
  TRANSITIONS,
  type DownloadedFields,
  type Status,
  type Ports,
  type Event,
  type Effect,
  type RequestsState,
  type TransitionResult,
} from './state';

const USER_ID = '11111111-1111-7111-8111-111111111111';

// All known DB statuses. Used by the property test to walk illegal sources
// (every status that isn't in a descriptor's `sources` list).
const ALL_STATUSES: Status[] = [
  'pending',
  'downloading',
  'guard_review',
  'parent_review',
  'approved',
  'ready',
  'rejected',
  'failed',
  'watched',
  'dismissed',
  'deleted',
];

// Map an Effect kind to the Ports method that runEffect dispatches it to.
// Used by the property test to assert that the fake ports were called
// exactly the set of times that the descriptor declared.
const EFFECT_KIND_TO_PORT: Record<Effect['kind'], keyof Ports> = {
  notify_video_ready: 'notifyVideoReady',
  enqueue_download: 'enqueueDownload',
  enqueue_delete: 'enqueueDelete',
  cancel_download_job_fire: 'cancelDownloadJob',
  cancel_download_job_awaited: 'cancelDownloadJob',
  redis_del: 'redisDel',
  ensure_person_capture: 'ensurePerson',
};

function makeFakePorts(): Ports {
  return {
    notifyVideoReady: vi.fn().mockResolvedValue(undefined),
    enqueueDownload: vi.fn().mockResolvedValue(undefined),
    enqueueDelete: vi.fn().mockResolvedValue(undefined),
    cancelDownloadJob: vi.fn().mockResolvedValue(undefined),
    redisDel: vi.fn().mockResolvedValue(1),
    ensurePerson: vi.fn().mockReturnValue({ personId: 'person-1', created: true }),
    applyChannelInfo: vi.fn().mockResolvedValue(undefined),
  };
}

let state: RequestsState;
let fakePorts: Ports;

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
  fakePorts = makeFakePorts();
  state = createRequestsState({ ports: fakePorts });
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.debug).mockClear();
});

describe('mark_watched', () => {
  it('transitions ready → watched and returns the user_id', () => {
    insertRequest({ request_id: 'req-1', status: 'ready' });

    const { result } = state.apply({ kind: 'mark_watched', requestId: 'req-1' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
  });

  it('sets watched_at on the row when the transition succeeds', () => {
    insertRequest({ request_id: 'req-2', status: 'ready' });
    const before = Date.now();

    state.apply({ kind: 'mark_watched', requestId: 'req-2' });

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

    const { result } = state.apply({ kind: 'mark_watched', requestId: 'req-3' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'watched' });
    const row = db
      .prepare('SELECT watched_at FROM requests WHERE request_id = ?')
      .get('req-3') as { watched_at: string };
    expect(row.watched_at).toBe(originalWatchedAt);
  });

  it('is a no-op on a rejected row', () => {
    insertRequest({ request_id: 'req-4', status: 'rejected' });

    const { result } = state.apply({ kind: 'mark_watched', requestId: 'req-4' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT status, watched_at FROM requests WHERE request_id = ?')
      .get('req-4') as { status: string; watched_at: string | null };
    expect(row.status).toBe('rejected');
    expect(row.watched_at).toBeNull();
  });
});

describe('mark_cancelled', () => {
  it('transitions downloading → rejected with sentinel reason and cancels the download job + progress key', async () => {
    insertRequest({ request_id: 'req-c1', status: 'downloading' });

    const { result } = state.apply({ kind: 'mark_cancelled', requestId: 'req-c1' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, rejection_reason FROM requests WHERE request_id = ?')
      .get('req-c1') as { status: string; rejection_reason: string };
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe(CANCELLED_REASON);

    // Cancel is fire-and-forget — let the dispatched effects settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakePorts.cancelDownloadJob).toHaveBeenCalledWith('req-c1');
    expect(fakePorts.redisDel).toHaveBeenCalledWith('eddy:progress:req-c1');
  });

  it('is a no-op on an already-rejected row and does not touch the cancel ports', () => {
    insertRequest({ request_id: 'req-c2', status: 'rejected' });

    const { result } = state.apply({ kind: 'mark_cancelled', requestId: 'req-c2' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(fakePorts.cancelDownloadJob).not.toHaveBeenCalled();
    expect(fakePorts.redisDel).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not touch the cancel ports', () => {
    const { result } = state.apply({ kind: 'mark_cancelled', requestId: 'does-not-exist' });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(fakePorts.cancelDownloadJob).not.toHaveBeenCalled();
    expect(fakePorts.redisDel).not.toHaveBeenCalled();
  });
});

describe('mark_soft_deleted', () => {
  const FILE_PATH = '/mnt/ssd/eddy/videos/abc123.mp4';

  it('transitions ready → deleted, sets columns, and enqueues a delete job', () => {
    insertRequest({ request_id: 'req-s1', status: 'ready', file_path: FILE_PATH });
    const before = Date.now();

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s1' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, file_state, deleted_at FROM requests WHERE request_id = ?')
      .get('req-s1') as { status: string; file_state: string; deleted_at: string | null };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');
    expect(row.deleted_at).not.toBeNull();
    expect(new Date(row.deleted_at!).getTime()).toBeGreaterThanOrEqual(before);

    // The unlink itself runs on the Ubuntu worker — the M4 just enqueues the job.
    // jobId must not contain ':' — BullMQ rejects non-3-segment colon ids.
    expect(fakePorts.enqueueDelete).toHaveBeenCalledWith(
      { requestId: 'req-s1', filePath: FILE_PATH },
      { jobId: 'delete-req-s1' },
    );
    const enqueuedJobId = vi.mocked(fakePorts.enqueueDelete).mock.calls[0]![1].jobId;
    expect(enqueuedJobId).not.toContain(':');
  });

  it('transitions watched → deleted and enqueues a delete job', () => {
    insertRequest({ request_id: 'req-s2', status: 'watched', file_path: FILE_PATH });

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s2' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s2') as { status: string; file_state: string };
    expect(row.status).toBe('deleted');
    expect(row.file_state).toBe('gone');

    expect(fakePorts.enqueueDelete).toHaveBeenCalledWith(
      { requestId: 'req-s2', filePath: FILE_PATH },
      { jobId: 'delete-req-s2' },
    );
  });

  it('is a no-op on a downloading row and does not enqueue', () => {
    insertRequest({ request_id: 'req-s3', status: 'downloading', file_path: FILE_PATH });

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s3' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
    const row = db
      .prepare('SELECT status, file_state FROM requests WHERE request_id = ?')
      .get('req-s3') as { status: string; file_state: string };
    expect(row.status).toBe('downloading');
    expect(row.file_state).toBe('live');
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('is a no-op on a rejected row and does not enqueue', () => {
    insertRequest({ request_id: 'req-s4', status: 'rejected', file_path: FILE_PATH });

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s4' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not enqueue', () => {
    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'does-not-exist' });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('does not enqueue when the row has no file_path', () => {
    insertRequest({ request_id: 'req-s5', status: 'ready', file_path: null });

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s5' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('warn-logs but still marks deleted when the queue enqueue throws', async () => {
    insertRequest({ request_id: 'req-s6', status: 'ready', file_path: FILE_PATH });
    vi.mocked(fakePorts.enqueueDelete).mockRejectedValueOnce(new Error('redis down'));

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s6' });
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

  // #114 contract: file_size_bytes is null for every row without a live file.
  // mark_soft_deleted is the one production path that flips file_state to
  // 'gone'; if it left the bytes set, the recycler's per-user accounting
  // would count files that aren't on disk any more.
  it('nulls file_size_bytes when flipping file_state to gone', () => {
    insertRequest({ request_id: 'req-s7', status: 'ready', file_path: FILE_PATH });
    db.prepare('UPDATE requests SET file_size_bytes = ? WHERE request_id = ?')
      .run(123_456_789, 'req-s7');

    const { result } = state.apply({ kind: 'mark_soft_deleted', requestId: 'req-s7' });
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    const row = db
      .prepare('SELECT file_state, file_size_bytes FROM requests WHERE request_id = ?')
      .get('req-s7') as { file_state: string; file_size_bytes: number | null };
    expect(row.file_state).toBe('gone');
    expect(row.file_size_bytes).toBeNull();
  });
});

describe('mark_recycled', () => {
  const FILE_PATH = '/mnt/ssd/eddy/videos/recycled.mp4';
  const NGINX_URL = 'http://mediaserver/videos/recycled.mp4';

  function insertRecyclable(opts: {
    request_id: string;
    status: Status;
    file_state?: string;
    file_size_bytes?: number | null;
    nginx_url?: string | null;
  }): void {
    insertRequest({
      request_id: opts.request_id,
      status: opts.status,
      file_path: FILE_PATH,
    });
    db.prepare(
      `UPDATE requests
         SET file_state = ?,
             file_size_bytes = ?,
             nginx_url = ?
       WHERE request_id = ?`,
    ).run(
      opts.file_state ?? 'live',
      opts.file_size_bytes ?? 500,
      opts.nginx_url ?? NGINX_URL,
      opts.request_id,
    );
  }

  it.each(['ready', 'watched', 'dismissed'] as const)(
    'transitions live → recycled from %s without changing status, nulls bytes/paths, enqueues delete',
    (sourceStatus) => {
      const requestId = `req-rcy-${sourceStatus}`;
      insertRecyclable({ request_id: requestId, status: sourceStatus });
      const before = Date.now();

      const { result } = state.apply({ kind: 'mark_recycled', requestId });

      expect(result).toEqual({ transitioned: true, userId: USER_ID });
      const row = db
        .prepare(
          `SELECT status, file_state, file_path, nginx_url, file_size_bytes, recycled_at
             FROM requests WHERE request_id = ?`,
        )
        .get(requestId) as {
          status: string; file_state: string;
          file_path: string | null; nginx_url: string | null;
          file_size_bytes: number | null; recycled_at: string | null;
        };
      expect(row.status).toBe(sourceStatus);
      expect(row.file_state).toBe('recycled');
      expect(row.file_path).toBeNull();
      expect(row.nginx_url).toBeNull();
      expect(row.file_size_bytes).toBeNull();
      expect(row.recycled_at).not.toBeNull();
      expect(new Date(row.recycled_at!).getTime()).toBeGreaterThanOrEqual(before);

      // Reuses the existing delete queue — same jobId shape as soft-delete.
      expect(fakePorts.enqueueDelete).toHaveBeenCalledWith(
        { requestId, filePath: FILE_PATH },
        { jobId: `delete-${requestId}` },
      );
    },
  );

  it('is a no-op on an already-recycled row (file_state != live) and does not enqueue', () => {
    insertRecyclable({
      request_id: 'req-rcy-already',
      status: 'watched',
      file_state: 'recycled',
      file_size_bytes: null,
    });

    const { result } = state.apply({ kind: 'mark_recycled', requestId: 'req-rcy-already' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'watched' });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('is a no-op on a downloading row and does not enqueue', () => {
    insertRecyclable({ request_id: 'req-rcy-dl', status: 'downloading' });

    const { result } = state.apply({ kind: 'mark_recycled', requestId: 'req-rcy-dl' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not enqueue', () => {
    const { result } = state.apply({ kind: 'mark_recycled', requestId: 'does-not-exist' });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('does not enqueue when the row has no file_path', () => {
    insertRequest({ request_id: 'req-rcy-nofile', status: 'ready', file_path: null });
    // file_state defaults to 'live' from migration 002. Even with no file_path
    // the descriptor still flips columns — but no unlink work to queue.
    const { result } = state.apply({ kind: 'mark_recycled', requestId: 'req-rcy-nofile' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT file_state FROM requests WHERE request_id = ?')
      .get('req-rcy-nofile') as { file_state: string };
    expect(row.file_state).toBe('recycled');
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });

  it('is idempotent — second apply on a recycled row is a no-op', () => {
    insertRecyclable({ request_id: 'req-rcy-idem', status: 'ready' });

    const first = state.apply({ kind: 'mark_recycled', requestId: 'req-rcy-idem' });
    expect(first.result).toEqual({ transitioned: true, userId: USER_ID });

    vi.mocked(fakePorts.enqueueDelete).mockClear();

    const second = state.apply({ kind: 'mark_recycled', requestId: 'req-rcy-idem' });
    expect(second.result).toEqual({ transitioned: false, currentStatus: 'ready' });
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
  });
});

describe('mark_restored', () => {
  const FILE_PATH = '/mnt/ssd/eddy/videos/restored.mp4';
  const NGINX_URL = 'http://mediaserver/videos/restored.mp4';
  const THUMB_URL = 'https://m4.local/thumbs/restored.jpg';
  const FIELDS = {
    filePath: FILE_PATH,
    nginxUrl: NGINX_URL,
    thumbnailUrl: THUMB_URL,
    fileSizeBytes: 987_654_321,
  };

  function insertRecycledRow(opts: {
    request_id: string;
    status: Status;
    thumbnail_url?: string | null;
  }): void {
    insertRequest({
      request_id: opts.request_id,
      status: opts.status,
      file_path: null,
    });
    db.prepare(
      `UPDATE requests
         SET file_state      = 'recycled',
             file_path       = NULL,
             nginx_url       = NULL,
             file_size_bytes = NULL,
             recycled_at     = ?,
             thumbnail_url   = ?
       WHERE request_id = ?`,
    ).run(
      '2026-04-01T00:00:00.000Z',
      opts.thumbnail_url ?? null,
      opts.request_id,
    );
  }

  it.each(['ready', 'watched', 'dismissed'] as const)(
    'restores a recycled row from %s, preserving status and re-populating columns',
    (sourceStatus) => {
      const requestId = `req-res-${sourceStatus}`;
      insertRecycledRow({ request_id: requestId, status: sourceStatus });

      const { result } = state.apply({ kind: 'mark_restored', requestId, fields: FIELDS });

      expect(result).toEqual({ transitioned: true, userId: USER_ID });
      const row = db
        .prepare(
          `SELECT status, file_state, file_path, nginx_url, thumbnail_url,
                  file_size_bytes, recycled_at
             FROM requests WHERE request_id = ?`,
        )
        .get(requestId) as {
          status: string; file_state: string;
          file_path: string | null; nginx_url: string | null;
          thumbnail_url: string | null; file_size_bytes: number | null;
          recycled_at: string | null;
        };
      expect(row.status).toBe(sourceStatus);
      expect(row.file_state).toBe('live');
      expect(row.file_path).toBe(FILE_PATH);
      expect(row.nginx_url).toBe(NGINX_URL);
      expect(row.thumbnail_url).toBe(THUMB_URL);
      expect(row.file_size_bytes).toBe(FIELDS.fileSizeBytes);
      expect(row.recycled_at).toBeNull();
    },
  );

  // The defining property: an existing editorial thumbnail captured on the
  // original download must survive a restore, regardless of whether the
  // payload carries the worker's maxresdefault fallback URL or a null. The
  // worker always sends a non-null thumbnail URL (the maxresdefault fallback)
  // on every download, so the COALESCE ordering in the descriptor SQL — row
  // value first, payload second — is the only thing stopping the fallback
  // from overwriting an editorial pick. Restore also skips the thumb-upgrade
  // job, so if the fallback won here the editorial pick would be lost forever.
  it('preserves an existing editorial thumbnail when the payload carries the worker fallback URL', () => {
    const requestId = 'req-res-keepthumb-fallback';
    insertRecycledRow({
      request_id: requestId,
      status: 'watched',
      thumbnail_url: 'https://existing/editorial.jpg',
    });

    const fieldsWithFallback = {
      ...FIELDS,
      thumbnailUrl: `https://i.ytimg.com/vi/${requestId}/maxresdefault.jpg`,
    };
    const { result } = state.apply({ kind: 'mark_restored', requestId, fields: fieldsWithFallback });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT thumbnail_url FROM requests WHERE request_id = ?')
      .get(requestId) as { thumbnail_url: string };
    expect(row.thumbnail_url).toBe('https://existing/editorial.jpg');
  });

  it('preserves an existing thumbnail_url when the restore payload carries null', () => {
    const requestId = 'req-res-keepthumb-null';
    insertRecycledRow({
      request_id: requestId,
      status: 'watched',
      thumbnail_url: 'https://existing/editorial.jpg',
    });

    const fieldsNoThumb = { ...FIELDS, thumbnailUrl: null };
    const { result } = state.apply({ kind: 'mark_restored', requestId, fields: fieldsNoThumb });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT thumbnail_url FROM requests WHERE request_id = ?')
      .get(requestId) as { thumbnail_url: string };
    expect(row.thumbnail_url).toBe('https://existing/editorial.jpg');
  });

  // Defensive: pre-#43 rows might lack a thumbnail entirely. In that case
  // COALESCE falls through to the payload, so the row at least gets the
  // worker's fallback URL rather than staying null.
  it('falls back to the payload thumbnail_url when the row has none', () => {
    const requestId = 'req-res-falloverthumb';
    insertRecycledRow({
      request_id: requestId,
      status: 'watched',
      thumbnail_url: null,
    });

    const fieldsWithFallback = {
      ...FIELDS,
      thumbnailUrl: 'https://i.ytimg.com/vi/x/maxresdefault.jpg',
    };
    state.apply({ kind: 'mark_restored', requestId, fields: fieldsWithFallback });

    const row = db
      .prepare('SELECT thumbnail_url FROM requests WHERE request_id = ?')
      .get(requestId) as { thumbnail_url: string };
    expect(row.thumbnail_url).toBe('https://i.ytimg.com/vi/x/maxresdefault.jpg');
  });

  it('is a no-op on a live row (file_state mismatch) and does not change file_path', () => {
    insertRequest({ request_id: 'req-res-live', status: 'watched', file_path: '/old/path.mp4' });
    // file_state defaults to 'live'

    const { result } = state.apply({ kind: 'mark_restored', requestId: 'req-res-live', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: 'watched' });
    const row = db
      .prepare('SELECT file_state, file_path FROM requests WHERE request_id = ?')
      .get('req-res-live') as { file_state: string; file_path: string };
    expect(row.file_state).toBe('live');
    expect(row.file_path).toBe('/old/path.mp4');
  });

  it('is a no-op on a downloading row even if file_state is recycled', () => {
    // Synthetic but defensive: the source-status gate must still reject
    // statuses outside ['ready', 'watched', 'dismissed'] regardless of
    // file_state.
    insertRequest({ request_id: 'req-res-dl', status: 'downloading' });
    db.prepare('UPDATE requests SET file_state = ? WHERE request_id = ?')
      .run('recycled', 'req-res-dl');

    const { result } = state.apply({ kind: 'mark_restored', requestId: 'req-res-dl', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: 'downloading' });
  });

  it('returns currentStatus: null for an unknown id', () => {
    const { result } = state.apply({ kind: 'mark_restored', requestId: 'does-not-exist', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });

  it('does not call notify or any port', async () => {
    const requestId = 'req-res-noeffects';
    insertRecycledRow({ request_id: requestId, status: 'watched' });

    const { result, settled } = state.apply({ kind: 'mark_restored', requestId, fields: FIELDS });
    await settled;

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(fakePorts.notifyVideoReady).not.toHaveBeenCalled();
    expect(fakePorts.enqueueDownload).not.toHaveBeenCalled();
    expect(fakePorts.enqueueDelete).not.toHaveBeenCalled();
    expect(fakePorts.ensurePerson).not.toHaveBeenCalled();
  });

  // Recycle then restore — the round trip that closes #116. status survives.
  it('round-trip: mark_recycled then mark_restored leaves status unchanged', () => {
    const requestId = 'req-res-roundtrip';
    insertRequest({ request_id: requestId, status: 'watched', file_path: FILE_PATH });
    db.prepare(
      `UPDATE requests SET file_state = ?, file_size_bytes = ?, nginx_url = ? WHERE request_id = ?`,
    ).run('live', 500, NGINX_URL, requestId);

    state.apply({ kind: 'mark_recycled', requestId });

    let row = db
      .prepare('SELECT status, file_state, recycled_at FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string; file_state: string; recycled_at: string | null };
    expect(row.status).toBe('watched');
    expect(row.file_state).toBe('recycled');
    expect(row.recycled_at).not.toBeNull();

    state.apply({ kind: 'mark_restored', requestId, fields: FIELDS });

    row = db
      .prepare('SELECT status, file_state, recycled_at FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string; file_state: string; recycled_at: string | null };
    expect(row.status).toBe('watched');
    expect(row.file_state).toBe('live');
    expect(row.recycled_at).toBeNull();
  });
});

describe('mark_downloaded', () => {
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
    fileSizeBytes: 123_456_789,
  };

  it('transitions downloading → ready, writes all fields, and fires notifyVideoReady', () => {
    insertRequest({ request_id: 'req-dl1', status: 'downloading' });
    const before = Date.now();

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl1', fields: FIELDS });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare(
        `SELECT status, title, channel, youtube_channel_id, description, duration_secs, transcript,
                file_path, nginx_url, thumbnail_url, file_size_bytes, downloaded_at
         FROM requests WHERE request_id = ?`,
      )
      .get('req-dl1') as {
        status: string; title: string; channel: string; youtube_channel_id: string;
        description: string;
        duration_secs: number; transcript: string; file_path: string;
        nginx_url: string; thumbnail_url: string; file_size_bytes: number;
        downloaded_at: string;
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
    expect(row.file_size_bytes).toBe(FIELDS.fileSizeBytes);
    expect(new Date(row.downloaded_at).getTime()).toBeGreaterThanOrEqual(before);

    expect(fakePorts.notifyVideoReady).toHaveBeenCalledWith(USER_ID, 'req-dl1', FIELDS.title);
  });

  it('writes null file_size_bytes when the worker could not stat the file', () => {
    insertRequest({ request_id: 'req-dl1b', status: 'downloading' });
    const fieldsNullSize: DownloadedFields = { ...FIELDS, fileSizeBytes: null };

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl1b', fields: fieldsNullSize });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT file_size_bytes FROM requests WHERE request_id = ?')
      .get('req-dl1b') as { file_size_bytes: number | null };
    expect(row.file_size_bytes).toBeNull();
  });

  it('is a no-op on an already-rejected row and does not fire the notification', () => {
    insertRequest({ request_id: 'req-dl2', status: 'rejected' });

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl2', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT status, title FROM requests WHERE request_id = ?')
      .get('req-dl2') as { status: string; title: string | null };
    expect(row.status).toBe('rejected');
    expect(row.title).toBeNull();
    expect(fakePorts.notifyVideoReady).not.toHaveBeenCalled();
  });

  it('is a no-op on an already-ready row and does not re-fire the notification', () => {
    insertRequest({ request_id: 'req-dl3', status: 'ready' });

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl3', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
    expect(fakePorts.notifyVideoReady).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not fire the notification', () => {
    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'does-not-exist', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(fakePorts.notifyVideoReady).not.toHaveBeenCalled();
  });

  it('warn-logs when notifyVideoReady rejects and does not surface as unhandled rejection', async () => {
    insertRequest({ request_id: 'req-dl4', status: 'downloading' });
    vi.mocked(fakePorts.notifyVideoReady).mockRejectedValueOnce(new Error('ntfy down'));

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl4', fields: FIELDS });
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    // Let the rejected fire-and-forget settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ requestId: 'req-dl4', userId: USER_ID });
  });

  it('ensures a person row and fires channel-info capture on first sighting of a channel', () => {
    insertRequest({ request_id: 'req-dl5', status: 'downloading' });

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl5', fields: FIELDS });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(fakePorts.ensurePerson).toHaveBeenCalledWith(FIELDS.youtubeChannelId, FIELDS.channel);
    expect(fakePorts.applyChannelInfo).toHaveBeenCalledWith('person-1', FIELDS.youtubeChannelId);
  });

  it('does not re-fire channel-info capture for a channel we already have a person row for', () => {
    insertRequest({ request_id: 'req-dl5b', status: 'downloading' });
    vi.mocked(fakePorts.ensurePerson).mockReturnValueOnce({ personId: 'person-1', created: false });

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl5b', fields: FIELDS });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(fakePorts.ensurePerson).toHaveBeenCalledWith(FIELDS.youtubeChannelId, FIELDS.channel);
    expect(fakePorts.applyChannelInfo).not.toHaveBeenCalled();
  });

  it('does not ensure a person row when youtubeChannelId is null', () => {
    insertRequest({ request_id: 'req-dl6', status: 'downloading' });
    const fieldsNoChannel: DownloadedFields = { ...FIELDS, youtubeChannelId: null };

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl6', fields: fieldsNoChannel });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(fakePorts.ensurePerson).not.toHaveBeenCalled();
    expect(fakePorts.applyChannelInfo).not.toHaveBeenCalled();
  });

  it('does not ensure a person row when the transition is a no-op', () => {
    insertRequest({ request_id: 'req-dl7', status: 'rejected' });

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl7', fields: FIELDS });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(fakePorts.ensurePerson).not.toHaveBeenCalled();
    expect(fakePorts.applyChannelInfo).not.toHaveBeenCalled();
  });

  it('debug-logs when applyChannelInfo rejects and does not surface as unhandled rejection', async () => {
    insertRequest({ request_id: 'req-dl8', status: 'downloading' });
    vi.mocked(fakePorts.applyChannelInfo).mockRejectedValueOnce(new Error('yt-dlp flaked'));

    const { result } = state.apply({ kind: 'mark_downloaded', requestId: 'req-dl8', fields: FIELDS });
    expect(result).toEqual({ transitioned: true, userId: USER_ID });

    // Let the rejected fire-and-forget settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.debug).mock.calls[0]!;
    expect(meta).toMatchObject({ channelId: FIELDS.youtubeChannelId });
  });
});

describe('mark_rejected', () => {
  it('transitions downloading → rejected and writes the reason', () => {
    insertRequest({ request_id: 'req-rj1', status: 'downloading' });

    const { result } = state.apply({ kind: 'mark_rejected', requestId: 'req-rj1', reason: 'yt-dlp 403' });

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

    const { result } = state.apply({ kind: 'mark_rejected', requestId: 'req-rj2', reason: 'new reason' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    const row = db
      .prepare('SELECT rejection_reason FROM requests WHERE request_id = ?')
      .get('req-rj2') as { rejection_reason: string };
    expect(row.rejection_reason).toBe('original reason');
  });

  it('is a no-op on a non-downloading source (e.g. ready)', () => {
    insertRequest({ request_id: 'req-rj3', status: 'ready' });

    const { result } = state.apply({ kind: 'mark_rejected', requestId: 'req-rj3', reason: 'too late' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
  });

  it('returns currentStatus: null for an unknown id', () => {
    const { result } = state.apply({ kind: 'mark_rejected', requestId: 'does-not-exist', reason: 'reason' });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('mark_guard_blocked', () => {
  it('transitions downloading → rejected with reason — same SQL as mark_rejected', () => {
    insertRequest({ request_id: 'req-gb1', status: 'downloading' });

    const { result } = state.apply({ kind: 'mark_guard_blocked', requestId: 'req-gb1', reason: 'unsafe content' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status, rejection_reason FROM requests WHERE request_id = ?')
      .get('req-gb1') as { status: string; rejection_reason: string };
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('unsafe content');
  });

  it('is a no-op on a non-downloading source', () => {
    insertRequest({ request_id: 'req-gb2', status: 'rejected' });

    const { result } = state.apply({ kind: 'mark_guard_blocked', requestId: 'req-gb2', reason: 'unsafe content' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
  });

  it('returns currentStatus: null for an unknown id', () => {
    const { result } = state.apply({ kind: 'mark_guard_blocked', requestId: 'does-not-exist', reason: 'unsafe' });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('mark_failed', () => {
  it('transitions downloading → failed', () => {
    insertRequest({ request_id: 'req-f1', status: 'downloading' });

    const { result } = state.apply({ kind: 'mark_failed', requestId: 'req-f1' });

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-f1') as { status: string };
    expect(row.status).toBe('failed');
  });

  it('is a no-op on a ready row and does not change status', () => {
    insertRequest({ request_id: 'req-f2', status: 'ready' });

    const { result } = state.apply({ kind: 'mark_failed', requestId: 'req-f2' });

    expect(result).toEqual({ transitioned: false, currentStatus: 'ready' });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-f2') as { status: string };
    expect(row.status).toBe('ready');
  });

  it('returns currentStatus: null for an unknown id', () => {
    const { result } = state.apply({ kind: 'mark_failed', requestId: 'does-not-exist' });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });
});

describe('retry', () => {
  const URL = 'https://www.youtube.com/watch?v=zzz';
  const YT_ID = 'zzz12345xyz';

  it('transitions failed → downloading, cancels the existing job, and re-adds with stored youtube_id and url', async () => {
    insertRequest({ request_id: 'req-r1', status: 'failed', youtube_id: YT_ID, url: URL });

    const { result, settled } = state.apply({ kind: 'retry', requestId: 'req-r1' });
    await settled;

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-r1') as { status: string };
    expect(row.status).toBe('downloading');

    expect(fakePorts.cancelDownloadJob).toHaveBeenCalledWith('req-r1');
    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId: 'req-r1', youtubeId: YT_ID, url: URL },
      { jobId: 'req-r1' },
    );
  });

  it('transitions downloading → downloading (idempotent re-enqueue) — same cancel + enqueue', async () => {
    insertRequest({ request_id: 'req-r2', status: 'downloading', youtube_id: YT_ID, url: URL });

    const { result, settled } = state.apply({ kind: 'retry', requestId: 'req-r2' });
    await settled;

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get('req-r2') as { status: string };
    expect(row.status).toBe('downloading');

    expect(fakePorts.cancelDownloadJob).toHaveBeenCalledTimes(1);
    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId: 'req-r2', youtubeId: YT_ID, url: URL },
      { jobId: 'req-r2' },
    );
  });

  it('is a no-op on a rejected row and does not touch the queue ports', async () => {
    insertRequest({ request_id: 'req-r3', status: 'rejected' });

    const { result, settled } = state.apply({ kind: 'retry', requestId: 'req-r3' });
    await settled;

    expect(result).toEqual({ transitioned: false, currentStatus: 'rejected' });
    expect(fakePorts.cancelDownloadJob).not.toHaveBeenCalled();
    expect(fakePorts.enqueueDownload).not.toHaveBeenCalled();
  });

  it('returns currentStatus: null for an unknown id and does not touch the queue ports', async () => {
    const { result, settled } = state.apply({ kind: 'retry', requestId: 'does-not-exist' });
    await settled;

    expect(result).toEqual({ transitioned: false, currentStatus: null });
    expect(fakePorts.cancelDownloadJob).not.toHaveBeenCalled();
    expect(fakePorts.enqueueDownload).not.toHaveBeenCalled();
  });

  it('logs-warned but still re-adds when cancelling the existing job throws', async () => {
    insertRequest({ request_id: 'req-r4', status: 'failed', youtube_id: YT_ID, url: URL });
    vi.mocked(fakePorts.cancelDownloadJob).mockRejectedValueOnce(new Error('redis down'));

    const { result, settled } = state.apply({ kind: 'retry', requestId: 'req-r4' });
    await settled;

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(fakePorts.enqueueDownload).toHaveBeenCalledTimes(1);
  });

  it('logs-warned and does not throw when enqueuing the new job fails', async () => {
    insertRequest({ request_id: 'req-r5', status: 'failed', youtube_id: YT_ID, url: URL });
    vi.mocked(fakePorts.enqueueDownload).mockRejectedValueOnce(new Error('redis down'));

    const { result, settled } = state.apply({ kind: 'retry', requestId: 'req-r5' });
    await settled;

    expect(result).toEqual({ transitioned: true, userId: USER_ID });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('passes empty string when youtube_id is null on the row', async () => {
    insertRequest({ request_id: 'req-r6', status: 'failed', youtube_id: null, url: URL });

    const { settled } = state.apply({ kind: 'retry', requestId: 'req-r6' });
    await settled;

    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId: 'req-r6', youtubeId: '', url: URL },
      { jobId: 'req-r6' },
    );
  });
});

describe('create_share_sheet', () => {
  const URL = 'https://www.youtube.com/watch?v=abc';
  const YT_ID = 'abc12345xyz';

  it('inserts a downloading share_sheet row with auto decision and enqueues with the new id', async () => {
    const requestId = 'req-css1';
    const before = Date.now();

    const { settled } = state.apply({
      kind: 'create_share_sheet',
      requestId,
      input: { url: URL, userId: USER_ID, youtubeId: YT_ID },
    });
    await settled;

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

    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId, youtubeId: YT_ID, url: URL },
      { jobId: requestId },
    );
  });

  it('passes empty string youtubeId to enqueueDownload when caller omits it', async () => {
    const requestId = 'req-css2';
    const { settled } = state.apply({
      kind: 'create_share_sheet',
      requestId,
      input: { url: URL, userId: USER_ID },
    });
    await settled;

    const row = db
      .prepare('SELECT youtube_id FROM requests WHERE request_id = ?')
      .get(requestId) as { youtube_id: string | null };
    expect(row.youtube_id).toBeNull();

    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId, youtubeId: '', url: URL },
      { jobId: requestId },
    );
  });

  it('leaves the row in place and warn-logs when enqueueDownload throws', async () => {
    vi.mocked(fakePorts.enqueueDownload).mockRejectedValueOnce(new Error('redis down'));

    const requestId = 'req-css3';
    const { settled } = state.apply({
      kind: 'create_share_sheet',
      requestId,
      input: { url: URL, userId: USER_ID, youtubeId: YT_ID },
    });
    await settled;

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string };
    expect(row.status).toBe('downloading');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ requestId });
  });
});

describe('create_channel_poll', () => {
  const URL = 'https://www.youtube.com/watch?v=poll1';
  const YT_ID = 'poll1xxxxxx';
  const CHANNEL_ID = 'UCpoll1xxxxxxxxxxxxxxxxx';
  const TITLE = 'Episode 42';
  const CHANNEL = 'A Followed Creator';

  it('inserts a downloading channel_subscription row with title/channel/youtube_channel_id/file_state=live and no decided_by', async () => {
    const requestId = 'req-ccp1';
    const before = Date.now();

    const { settled } = state.apply({
      kind: 'create_channel_poll',
      requestId,
      input: {
        url: URL,
        userId: USER_ID,
        youtubeId: YT_ID,
        youtubeChannelId: CHANNEL_ID,
        title: TITLE,
        channel: CHANNEL,
      },
    });
    await settled;

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

    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId, youtubeId: YT_ID, url: URL },
      { jobId: requestId },
    );
  });

  it('leaves the row in place and warn-logs when enqueueDownload throws', async () => {
    vi.mocked(fakePorts.enqueueDownload).mockRejectedValueOnce(new Error('redis down'));

    const requestId = 'req-ccp2';
    const { settled } = state.apply({
      kind: 'create_channel_poll',
      requestId,
      input: {
        url: URL,
        userId: USER_ID,
        youtubeId: YT_ID,
        youtubeChannelId: CHANNEL_ID,
        title: TITLE,
        channel: CHANNEL,
      },
    });
    await settled;

    const row = db
      .prepare('SELECT status FROM requests WHERE request_id = ?')
      .get(requestId) as { status: string };
    expect(row.status).toBe('downloading');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

describe('create_candidate', () => {
  const URL = 'https://www.youtube.com/watch?v=cand1';
  const YT_ID = 'cand1xxxxxx';
  const TITLE = 'A picked-for-you title';

  it('inserts a downloading recommended row with title and auto decision', async () => {
    const requestId = 'req-cc1';
    const before = Date.now();

    const { settled } = state.apply({
      kind: 'create_candidate',
      requestId,
      input: { url: URL, userId: USER_ID, youtubeId: YT_ID, title: TITLE, whyText: null },
    });
    await settled;

    const row = db
      .prepare(
        `SELECT source, url, youtube_id, title, status, decided_by, decided_at, requested_at, added_at
           FROM requests WHERE request_id = ?`,
      )
      .get(requestId) as {
        source: string; url: string; youtube_id: string; title: string;
        status: string; decided_by: string; decided_at: string;
        requested_at: string; added_at: string | null;
      };
    expect(row.source).toBe('recommended');
    expect(row.url).toBe(URL);
    expect(row.youtube_id).toBe(YT_ID);
    expect(row.title).toBe(TITLE);
    expect(row.status).toBe('downloading');
    expect(row.decided_by).toBe('auto');
    expect(new Date(row.decided_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(row.requested_at).getTime()).toBeGreaterThanOrEqual(before);
    // Feed query orders by added_at DESC with a fixed cap — a NULL would push
    // the row out of the cap and make the accept look like a silent dismiss.
    expect(row.added_at).not.toBeNull();
    expect(new Date(row.added_at!).getTime()).toBeGreaterThanOrEqual(before);

    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId, youtubeId: YT_ID, url: URL },
      { jobId: requestId },
    );
  });

  it('passes empty string youtubeId to enqueueDownload when external_id is null', async () => {
    const requestId = 'req-cc2';
    const { settled } = state.apply({
      kind: 'create_candidate',
      requestId,
      input: { url: URL, userId: USER_ID, youtubeId: null, title: TITLE, whyText: null },
    });
    await settled;

    expect(fakePorts.enqueueDownload).toHaveBeenCalledWith(
      { requestId, youtubeId: '', url: URL },
      { jobId: requestId },
    );
  });

  it('persists whyText onto the request so the detail page can render it later', async () => {
    const requestId = 'req-cc-why';
    const WHY = 'Because Steve Mould has been on your radar this month.';
    const { settled } = state.apply({
      kind: 'create_candidate',
      requestId,
      input: { url: URL, userId: USER_ID, youtubeId: YT_ID, title: TITLE, whyText: WHY },
    });
    await settled;

    const row = db.prepare('SELECT why_text FROM requests WHERE request_id = ?')
      .get(requestId) as { why_text: string | null };
    expect(row.why_text).toBe(WHY);
  });

  it('leaves the row in place and warn-logs when enqueueDownload throws', async () => {
    vi.mocked(fakePorts.enqueueDownload).mockRejectedValueOnce(new Error('redis down'));

    const requestId = 'req-cc3';
    const { settled } = state.apply({
      kind: 'create_candidate',
      requestId,
      input: { url: URL, userId: USER_ID, youtubeId: YT_ID, title: TITLE, whyText: null },
    });
    await settled;

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

// ─── TRANSITIONS property test ───────────────────────────────────────────────
//
// Walks every `(Event type × source status)` pair off the `TRANSITIONS`
// descriptor table at runtime. For each pair we assert:
//
//   - A row in a legal `source` transitions to `target` and apply returns
//     `{ transitioned: true, userId }`.
//   - A row in any other `source` (and an unknown id) returns
//     `{ transitioned: false, currentStatus }` and emits no effects.
//   - For each declared effect, the matching fake port is called.
//
// `it.each` pulls pairs straight off `TRANSITIONS` so adding or changing a
// descriptor entry is picked up automatically without test maintenance.

// Build a representative Event for a given event kind. Each event carries the
// minimum data the descriptor's buildSql / effects need; the property test
// pre-populates the matching row columns (youtube_id, url, file_path) so the
// effects fire as declared.
const PROP_URL = 'https://www.youtube.com/watch?v=prop1';
const PROP_YT_ID = 'prop1xxxxxx';
const PROP_CHANNEL_ID = 'UCprop1xxxxxxxxxxxxxxxx';
const PROP_FILE_PATH = '/mnt/ssd/eddy/videos/prop1.mp4';
const PROP_DOWNLOADED_FIELDS: DownloadedFields = {
  title: 'Property title',
  channel: 'Property channel',
  youtubeChannelId: PROP_CHANNEL_ID,
  description: 'd',
  durationSecs: 10,
  transcript: null,
  filePath: PROP_FILE_PATH,
  nginxUrl: null,
  thumbnailUrl: null,
  fileSizeBytes: 42,
};

function buildEvent(kind: Event['kind'], requestId: string): Event {
  switch (kind) {
    case 'mark_watched':
      return { kind, requestId };
    case 'mark_soft_deleted':
      return { kind, requestId };
    case 'mark_recycled':
      return { kind, requestId };
    case 'mark_restored':
      return {
        kind,
        requestId,
        fields: {
          filePath: PROP_FILE_PATH,
          nginxUrl: null,
          thumbnailUrl: null,
          fileSizeBytes: 84,
        },
      };
    case 'mark_downloaded':
      return { kind, requestId, fields: PROP_DOWNLOADED_FIELDS };
    case 'mark_rejected':
      return { kind, requestId, reason: 'prop reject reason' };
    case 'mark_guard_blocked':
      return { kind, requestId, reason: 'prop guard reason' };
    case 'mark_cancelled':
      return { kind, requestId };
    case 'mark_failed':
      return { kind, requestId };
    case 'retry':
      return { kind, requestId };
    case 'create_share_sheet':
      return {
        kind,
        requestId,
        input: { url: PROP_URL, userId: USER_ID, youtubeId: PROP_YT_ID },
      };
    case 'create_channel_poll':
      return {
        kind,
        requestId,
        input: {
          url: PROP_URL,
          userId: USER_ID,
          youtubeId: PROP_YT_ID,
          youtubeChannelId: PROP_CHANNEL_ID,
          title: PROP_DOWNLOADED_FIELDS.title,
          channel: PROP_DOWNLOADED_FIELDS.channel,
        },
      };
    case 'create_candidate':
      return {
        kind,
        requestId,
        input: {
          url: PROP_URL,
          userId: USER_ID,
          youtubeId: PROP_YT_ID,
          title: PROP_DOWNLOADED_FIELDS.title,
          whyText: null,
        },
      };
  }
}

// Type-narrowing helper: TRANSITIONS values are typed as Descriptor<E> where
// E is the matching extract of Event, but we walk it by string key at runtime.
// Cast to a generic shape that matches what the property test reads.
interface GenericDescriptor {
  sources: Status[] | 'creation';
  target: Status | 'preserve';
  effects: (event: Event, result: TransitionResult) => Effect[];
}

// Build the (eventKind, source) pairs to feed into it.each. Mutation events
// produce one row per legal source; creation events produce a single row
// flagged with source='creation' so the test exercises the INSERT path. The
// `target` field on each row is the post-transition status the test should
// assert against. `descriptor.target === 'preserve'` (status-preserving
// descriptors like mark_recycled) resolves to the row's source status.
type LegalPairRow = {
  kind: Event['kind'];
  source: Status | 'creation';
  target: Status;
};

const LEGAL_PAIRS: LegalPairRow[] = (Object.entries(TRANSITIONS) as [Event['kind'], GenericDescriptor][])
  .flatMap(([kind, descriptor]): LegalPairRow[] => {
    if (descriptor.sources === 'creation') {
      // Creation descriptors must declare a concrete target; 'preserve' would
      // be meaningless on an INSERT (there's no prior status to preserve).
      if (descriptor.target === 'preserve') {
        throw new Error(`Creation descriptor ${kind} cannot use 'preserve' target`);
      }
      return [{ kind, source: 'creation', target: descriptor.target }];
    }
    return descriptor.sources.map((source) => ({
      kind,
      source,
      target: descriptor.target === 'preserve' ? source : descriptor.target,
    }));
  });

type IllegalPairRow = { kind: Event['kind']; source: Status };

const ILLEGAL_PAIRS: IllegalPairRow[] = (Object.entries(TRANSITIONS) as [Event['kind'], GenericDescriptor][])
  .flatMap(([kind, descriptor]) => {
    // Creation events have no source-status gate, so there are no illegal
    // sources to walk for them — the INSERT path is exercised in LEGAL_PAIRS.
    if (descriptor.sources === 'creation') return [];
    const legal = new Set(descriptor.sources);
    return ALL_STATUSES.filter((s) => !legal.has(s)).map((source) => ({ kind, source }));
  });

describe('TRANSITIONS property test', () => {
  // For the property test we want `ensurePerson` to report "we already had
  // this person", so `runEffect` doesn't fire the follow-up applyChannelInfo
  // call. That keeps the declared-vs-observed effect counts strictly equal
  // for `mark_downloaded`. The downloaded-then-new-channel path is asserted
  // separately in the dedicated `mark_downloaded` describe.
  beforeEach(() => {
    vi.mocked(fakePorts.ensurePerson).mockReturnValue({ personId: 'person-1', created: false });
  });

  it.each(LEGAL_PAIRS)(
    '$kind from $source transitions to $target and fires declared effects',
    async ({ kind, source, target }) => {
      const requestId = `prop-${kind}-${source}`;
      const descriptor = TRANSITIONS[kind] as GenericDescriptor;

      if (source === 'creation') {
        // INSERT path: build the event with the row id pre-chosen, apply,
        // assert the row landed at `target` and that the declared effects fired.
        const event = buildEvent(kind, requestId);
        const { result, settled } = state.apply(event);
        await settled;

        expect(result).toEqual({ transitioned: true, userId: '' });
        const row = db
          .prepare('SELECT status FROM requests WHERE request_id = ?')
          .get(requestId) as { status: string } | undefined;
        expect(row?.status).toBe(target);
      } else {
        // Mutation path: seed a row at `source` with all the columns any
        // descriptor might read in `effects(...)` (file_path for soft-delete,
        // youtube_id/url for retry).
        insertRequest({
          request_id: requestId,
          status: source,
          file_path: PROP_FILE_PATH,
          youtube_id: PROP_YT_ID,
          url: PROP_URL,
        });
        // mark_restored gates on file_state = 'recycled'; the default row
        // file_state is 'live' (migration 002). Flip it so the descriptor's
        // SQL WHERE actually matches. Illegal sources (downloading, …) are
        // still rejected by the status check, so the ILLEGAL_PAIRS coverage
        // stays correct without a parallel fix.
        if (kind === 'mark_restored') {
          db.prepare('UPDATE requests SET file_state = ? WHERE request_id = ?')
            .run('recycled', requestId);
        }

        const event = buildEvent(kind, requestId);
        const { result, settled } = state.apply(event);
        await settled;

        expect(result).toEqual({ transitioned: true, userId: USER_ID });
        const row = db
          .prepare('SELECT status FROM requests WHERE request_id = ?')
          .get(requestId) as { status: string };
        expect(row.status).toBe(target);
      }

      // Assert that the fake ports were called the exact number of times the
      // descriptor's `effects` function declared. We feed `effects` a hand-rolled
      // SqlResultCarrier-shaped result to compute the expected effect list:
      // descriptors that read RETURNING columns (file_path / youtube_id / url)
      // see them via __sqlResult, which mirrors what runSql stashed at runtime.
      // Mirror the columns runSql merges into __sqlResult: every column a
      // descriptor might read in `effects(...)` (RETURNING columns from the
      // UPDATE, plus any preFetch keys). `pre_file_path` is mark_recycled's
      // preFetch alias for the pre-update file_path.
      const fakeResult: TransitionResult & { __sqlResult?: Record<string, unknown> } = {
        transitioned: true,
        userId: source === 'creation' ? '' : USER_ID,
        __sqlResult: {
          user_id: USER_ID,
          file_path: PROP_FILE_PATH,
          pre_file_path: PROP_FILE_PATH,
          youtube_id: PROP_YT_ID,
          url: PROP_URL,
        },
      };
      const expectedEffects = descriptor.effects(buildEvent(kind, requestId), fakeResult);
      const expectedCounts: Partial<Record<keyof Ports, number>> = {};
      for (const effect of expectedEffects) {
        const portName = EFFECT_KIND_TO_PORT[effect.kind];
        expectedCounts[portName] = (expectedCounts[portName] ?? 0) + 1;
      }
      for (const portName of Object.keys(fakePorts) as (keyof Ports)[]) {
        const expected = expectedCounts[portName] ?? 0;
        const fn = fakePorts[portName] as unknown as ReturnType<typeof vi.fn>;
        expect(
          fn.mock.calls.length,
          `expected ${expected} call(s) to ${portName} for ${kind} from ${source}, got ${fn.mock.calls.length}`,
        ).toBe(expected);
      }
    },
  );

  it.each(ILLEGAL_PAIRS)(
    '$kind from $source is a no-op and emits no effects',
    async ({ kind, source }) => {
      const requestId = `prop-illegal-${kind}-${source}`;
      insertRequest({
        request_id: requestId,
        status: source,
        file_path: PROP_FILE_PATH,
        youtube_id: PROP_YT_ID,
        url: PROP_URL,
      });

      const event = buildEvent(kind, requestId);
      const { result, settled } = state.apply(event);
      await settled;

      expect(result).toEqual({ transitioned: false, currentStatus: source });
      // The row's status is unchanged on an illegal source.
      const row = db
        .prepare('SELECT status FROM requests WHERE request_id = ?')
        .get(requestId) as { status: string };
      expect(row.status).toBe(source);

      // No fake port should have been touched on a no-op.
      for (const portName of Object.keys(fakePorts) as (keyof Ports)[]) {
        const fn = fakePorts[portName] as unknown as ReturnType<typeof vi.fn>;
        expect(
          fn.mock.calls.length,
          `expected 0 calls to ${portName} for no-op ${kind} from ${source}, got ${fn.mock.calls.length}`,
        ).toBe(0);
      }
    },
  );

  // Mutation events on an unknown id: result is currentStatus: null, no
  // effects fire. Creation events are excluded — they INSERT a fresh row,
  // which is a successful transition, not a no-op.
  const mutationKinds = (Object.entries(TRANSITIONS) as [Event['kind'], GenericDescriptor][])
    .filter(([, descriptor]) => descriptor.sources !== 'creation')
    .map(([kind]) => kind);

  it.each(mutationKinds)(
    '%s on an unknown id returns currentStatus: null and emits no effects',
    async (kind) => {
      const event = buildEvent(kind, `does-not-exist-${kind}`);
      const { result, settled } = state.apply(event);
      await settled;

      expect(result).toEqual({ transitioned: false, currentStatus: null });
      for (const portName of Object.keys(fakePorts) as (keyof Ports)[]) {
        const fn = fakePorts[portName] as unknown as ReturnType<typeof vi.fn>;
        expect(fn.mock.calls.length).toBe(0);
      }
    },
  );
});
