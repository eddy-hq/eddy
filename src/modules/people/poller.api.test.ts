import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The follow poll under DISCOVERY_SOURCE=api: uploads come from the Data API
// listing, not the RSS feed. The discovery-metadata seam is mocked whole, so
// these tests pin what the poller does with a listing, a failed listing and a
// wholesale-failed pass. (poller.test.ts covers the RSS fallback source.)
vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../config', () => ({
  config: { NODE_ENV: 'test', REDIS_URL: 'redis://fake', DISCOVERY_SOURCE: 'api' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../discovery-metadata', () => ({
  recentUploads: vi.fn(),
  videoDurations: vi.fn(),
}));

vi.mock('./registry', () => ({
  ensurePersonForChannel: vi.fn(),
  applyChannelInfoToPerson: vi.fn(),
}));

import { db } from '../../db/client';
import { logger } from '../../logger';
import { runMigrations } from '../../db/migrate';
import { recentUploads, videoDurations } from '../../discovery-metadata';
import { applyChannelInfoToPerson } from './registry';
import { pollChannel, runRssPollPass, type OutputRow } from './poller';

const USER_ID = '019d86c8-0000-7000-8000-000000000001';
const PERSON_ID = 'person-api-1';
const CHANNEL_ID = 'UCapitest0000000000000aa';
const OUTPUT: OutputRow = {
  output_id: 'output-api-1',
  channel_id: CHANNEL_ID,
  person_id: PERSON_ID,
  channel_name: 'Test Channel',
};

function upload(videoId: string, title = 'A video') {
  return { videoId, title, publishedAt: '2026-09-20T08:00:00Z', thumbnailUrl: null };
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  db.prepare('DELETE FROM candidate_pool').run();
  db.prepare('DELETE FROM seen_videos').run();
  db.prepare('DELETE FROM followed_people').run();
  db.prepare('DELETE FROM person_outputs').run();
  db.prepare('DELETE FROM people').run();
  db.prepare('DELETE FROM users').run();

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (user_id, display_name, role, created_at) VALUES (?, 'User1', 'adult', ?)`,
  ).run(USER_ID, now);
  db.prepare(
    `INSERT INTO people (person_id, display_name, created_at) VALUES (?, 'Test Channel', ?)`,
  ).run(PERSON_ID, now);
  db.prepare(
    `INSERT INTO person_outputs (output_id, person_id, output_type, fetcher_type, external_id, active)
     VALUES (?, ?, 'youtube', 'rss', ?, 1)`,
  ).run(OUTPUT.output_id, PERSON_ID, CHANNEL_ID);
  db.prepare(
    `INSERT INTO followed_people (user_id, person_id, followed_at) VALUES (?, ?, ?)`,
  ).run(USER_ID, PERSON_ID, now);
  // Not the first poll — so every unseen upload becomes a candidate.
  db.prepare(
    `INSERT INTO seen_videos (channel_id, video_id, seen_at) VALUES (?, 'already-seen', ?)`,
  ).run(CHANNEL_ID, now);

  vi.mocked(recentUploads).mockReset();
  vi.mocked(videoDurations).mockReset();
  vi.mocked(videoDurations).mockResolvedValue(new Map());
  vi.mocked(applyChannelInfoToPerson).mockReset();
  vi.mocked(applyChannelInfoToPerson).mockResolvedValue(undefined);
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.info).mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('RSS must not be fetched under the API source')));
});

function candidateIds(): string[] {
  return (db.prepare('SELECT external_id FROM candidate_pool ORDER BY external_id').all() as Array<{ external_id: string }>)
    .map((r) => r.external_id);
}

describe('pollChannel under the Data API source', () => {
  it('creates subscription candidates from the API listing without touching RSS', async () => {
    vi.mocked(recentUploads).mockResolvedValue([upload('apivid00001'), upload('apivid00002')]);

    await expect(pollChannel(OUTPUT)).resolves.toBe(true);

    expect(candidateIds()).toEqual(['apivid00001', 'apivid00002']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a failed listing → warn, false, nothing marked seen so the uploads retry next pass', async () => {
    vi.mocked(recentUploads).mockRejectedValue(new Error('YouTube API playlistItems returned 500'));

    await expect(pollChannel(OUTPUT)).resolves.toBe(false);

    expect(candidateIds()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM seen_videos').get()).toEqual({ n: 1 });
    expect(logger.warn).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('quota exhaustion on the listing propagates so the pass stands down', async () => {
    vi.mocked(recentUploads).mockRejectedValue(
      Object.assign(new Error('quotaExceeded'), { quotaExceeded: true }),
    );
    await expect(pollChannel(OUTPUT)).rejects.toMatchObject({ quotaExceeded: true });
  });
});

describe('runRssPollPass failure tally', () => {
  it('logs an error when every channel fails — a dead poll must not look like a quiet day', async () => {
    vi.mocked(recentUploads).mockRejectedValue(new Error('YouTube API playlistItems returned 500'));

    await runRssPollPass();

    expect(logger.error).toHaveBeenCalledWith(
      { count: 1 },
      expect.stringContaining('every channel failed'),
    );
  });

  it('stays quiet at error level when the listing was read, even with nothing new', async () => {
    vi.mocked(recentUploads).mockResolvedValue([]);

    await runRssPollPass();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ count: 1, failed: 0 }, 'RSS poll pass complete');
  });

  it('a quota stand-down is reported as such, not as every-channel-failed', async () => {
    vi.mocked(recentUploads).mockRejectedValue(
      Object.assign(new Error('quotaExceeded'), { quotaExceeded: true }),
    );

    await runRssPollPass();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { channelId: CHANNEL_ID },
      expect.stringContaining('quota exhausted'),
    );
  });
});
