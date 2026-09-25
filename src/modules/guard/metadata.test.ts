import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
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

vi.mock('../../discovery-metadata', () => ({
  videoMetadata: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { logger } from '../../logger';
import { videoMetadata, type VideoMetadata } from '../../discovery-metadata';
import { ensureVideoMetadata, categoryName } from './metadata';

function apiMeta(id: string, over: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    videoId: id,
    title: 'T',
    channel: 'C',
    channelId: 'UC1',
    durationSecs: 60,
    viewCount: 1,
    uploadDate: '20260101',
    thumbnailUrl: null,
    liveStatus: null,
    description: `About ${id}`,
    tags: ['a', 'b'],
    categoryId: '27',
    ageRestricted: false,
    madeForKids: null,
    ...over,
  };
}

function seedRow(id: string): void {
  db.prepare(`
    INSERT INTO video_metadata
      (youtube_id, description, tags_json, category_id, age_restricted, made_for_kids, fetched_at)
    VALUES (?, 'Stored', '["s"]', '10', 1, 0, '2026-01-01T00:00:00.000Z')
  `).run(id);
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  db.prepare('DELETE FROM video_metadata').run();
  vi.mocked(videoMetadata).mockReset();
  vi.mocked(logger.warn).mockClear();
});

describe('ensureVideoMetadata', () => {
  it('fetches only the ids without a stored row', async () => {
    seedRow('have1');
    vi.mocked(videoMetadata).mockResolvedValue(new Map([['new1', apiMeta('new1')]]));

    const result = await ensureVideoMetadata(['have1', 'new1', 'have1']);

    expect(videoMetadata).toHaveBeenCalledTimes(1);
    expect(videoMetadata).toHaveBeenCalledWith(['new1']);
    expect(result.get('have1')).toMatchObject({
      description: 'Stored', tags: ['s'], categoryId: '10', ageRestricted: true, madeForKids: false,
    });
    expect(result.get('new1')).toMatchObject({ description: 'About new1', tags: ['a', 'b'] });
  });

  it('makes no API call when every id is already stored', async () => {
    seedRow('have1');
    const result = await ensureVideoMetadata(['have1']);
    expect(videoMetadata).not.toHaveBeenCalled();
    expect(result.size).toBe(1);
  });

  it('persists fetched rows, mapping booleans and empty tags', async () => {
    vi.mocked(videoMetadata).mockResolvedValue(new Map([
      ['v1', apiMeta('v1', { ageRestricted: true, madeForKids: true })],
      ['v2', apiMeta('v2', { tags: [], description: null, categoryId: null, madeForKids: null })],
    ]));

    await ensureVideoMetadata(['v1', 'v2']);

    const rows = db.prepare('SELECT * FROM video_metadata ORDER BY youtube_id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      youtube_id: 'v1', tags_json: '["a","b"]', category_id: '27', age_restricted: 1, made_for_kids: 1,
    });
    expect(rows[1]).toMatchObject({
      youtube_id: 'v2', description: null, tags_json: null, category_id: null, age_restricted: 0, made_for_kids: null,
    });
    expect(typeof rows[0]?.['fetched_at']).toBe('string');
  });

  it('writes no row for ids the API omits', async () => {
    vi.mocked(videoMetadata).mockResolvedValue(new Map([['v1', apiMeta('v1')]]));
    const result = await ensureVideoMetadata(['v1', 'gone']);
    expect(result.has('gone')).toBe(false);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM video_metadata').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('fetches in batches of 50', async () => {
    vi.mocked(videoMetadata).mockResolvedValue(new Map());
    await ensureVideoMetadata(Array.from({ length: 120 }, (_, i) => `v${i}`));
    expect(vi.mocked(videoMetadata).mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
  });

  it('falls back to stored rows and warns when the fetch fails', async () => {
    seedRow('have1');
    vi.mocked(videoMetadata).mockRejectedValue(new Error('network down'));
    const result = await ensureVideoMetadata(['have1', 'new1']);
    expect(result.has('have1')).toBe(true);
    expect(result.has('new1')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('stops fetching after a quota stand-down, keeping earlier batches', async () => {
    const quotaErr = Object.assign(new Error('quota'), { quotaExceeded: true });
    vi.mocked(videoMetadata)
      .mockResolvedValueOnce(new Map([['v0', apiMeta('v0')]]))
      .mockRejectedValueOnce(quotaErr);
    const result = await ensureVideoMetadata(Array.from({ length: 120 }, (_, i) => `v${i}`));
    expect(videoMetadata).toHaveBeenCalledTimes(2);
    expect(result.has('v0')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('quota exhausted'),
    );
  });

  it('returns stored rows only when the source has no metadata read', async () => {
    seedRow('have1');
    vi.mocked(videoMetadata).mockResolvedValue(null);
    const result = await ensureVideoMetadata(['have1', 'new1']);
    expect([...result.keys()]).toEqual(['have1']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns an empty map for no ids without calling the API', async () => {
    const result = await ensureVideoMetadata([]);
    expect(result.size).toBe(0);
    expect(videoMetadata).not.toHaveBeenCalled();
  });
});

describe('categoryName', () => {
  it('maps assignable category ids and drops unknown ones', () => {
    expect(categoryName('27')).toBe('Education');
    expect(categoryName('20')).toBe('Gaming');
    expect(categoryName('999')).toBeNull();
    expect(categoryName(null)).toBeNull();
  });
});
