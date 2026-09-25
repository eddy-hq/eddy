import express, { type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  redis: { get: vi.fn(), del: vi.fn() },
  downloadQueue: { getJob: vi.fn(), add: vi.fn() },
  deleteQueue: { add: vi.fn() },
  guardQueue: {},
  discoveryQueue: {},
  thumbsQueue: {},
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn() }),
  generateActionToken: vi.fn(),
  validateActionToken: vi.fn(),
}));

// The source switch and the Data API call are covered in
// discovery-metadata.test.ts and youtubeapi.test.ts; here the seam is mocked
// so the test pins which search a kid vs an adult gets, and what the route
// does with the results.
const searchVideosFlat = vi.fn();
const searchVideosFlatStrict = vi.fn();
vi.mock('../../discovery-metadata', () => ({
  searchVideosFlat: (...args: unknown[]) => searchVideosFlat(...args),
  searchVideosFlatStrict: (...args: unknown[]) => searchVideosFlatStrict(...args),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { EddyError } from '../../errors';
import { searchRouter } from './index';

const app = express();
app.use(express.json());
app.use('/search', searchRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EddyError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const KID_USER_ID = '11111111-1111-7111-8111-111111111111';
const ADULT_USER_ID = '22222222-2222-7222-8222-222222222222';

function result(videoId: string) {
  return {
    videoId,
    title: `Placeholder ${videoId}`,
    channel: 'Placeholder channel',
    channelId: 'UCplaceholder',
    durationSecs: 300,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

interface VideosResponse {
  results: Array<{ videoId: string; thumbnailUrl: string | null; title: string; inLibrary: boolean }>;
  searchError: boolean;
  unavailable?: string;
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(KID_USER_ID, 'Boy1', 'kid', 12, now);
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(ADULT_USER_ID, 'Parent1', 'parent', 0, now);
});

beforeEach(() => {
  searchVideosFlat.mockReset();
  searchVideosFlatStrict.mockReset();
});

describe('GET /search/videos', () => {
  it('gives a kid the strict safe-search results with no thumbnail URLs', async () => {
    searchVideosFlatStrict.mockResolvedValue([result('a'), result('b')]);

    const res = await supertest(app).get('/search/videos').query({ q: 'robots', userId: KID_USER_ID });
    const body = res.body as VideosResponse;

    expect(res.status).toBe(200);
    expect(searchVideosFlatStrict).toHaveBeenCalledWith('robots');
    expect(searchVideosFlat).not.toHaveBeenCalled();
    expect(body.results.map((r) => r.videoId)).toEqual(['a', 'b']);
    expect(body.results.every((r) => r.thumbnailUrl === null)).toBe(true);
    expect(body.results[0]!.title).toBe('Placeholder a');
    expect(body.unavailable).toBeUndefined();
  });

  it('resolves a kid by display name too (share-sheet path)', async () => {
    searchVideosFlatStrict.mockResolvedValue([result('a')]);

    const res = await supertest(app).get('/search/videos').query({ q: 'robots', user: 'boy1' });

    expect(searchVideosFlatStrict).toHaveBeenCalled();
    expect((res.body as VideosResponse).results[0]!.thumbnailUrl).toBeNull();
  });

  it('returns no results with a reason when no safe-search source is available for a kid', async () => {
    searchVideosFlatStrict.mockResolvedValue(null);

    const res = await supertest(app).get('/search/videos').query({ q: 'robots', userId: KID_USER_ID });
    const body = res.body as VideosResponse;

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.searchError).toBe(false);
    expect(body.unavailable).toBe('safe_search_unavailable');
    expect(searchVideosFlat).not.toHaveBeenCalled();
  });

  it('leaves adult search unchanged: default search, thumbnails intact', async () => {
    searchVideosFlat.mockResolvedValue([result('a')]);

    const res = await supertest(app).get('/search/videos').query({ q: 'robots', userId: ADULT_USER_ID });
    const body = res.body as VideosResponse;

    expect(searchVideosFlat).toHaveBeenCalledWith('robots');
    expect(searchVideosFlatStrict).not.toHaveBeenCalled();
    expect(body.results[0]!.thumbnailUrl).toBe('https://i.ytimg.com/vi/a/hqdefault.jpg');
    expect(body.unavailable).toBeUndefined();
  });

  it('reports a search error for a kid without leaking results', async () => {
    searchVideosFlatStrict.mockRejectedValue(new Error('quota'));

    const res = await supertest(app).get('/search/videos').query({ q: 'robots', userId: KID_USER_ID });
    const body = res.body as VideosResponse;

    expect(body.results).toEqual([]);
    expect(body.searchError).toBe(true);
  });
});
