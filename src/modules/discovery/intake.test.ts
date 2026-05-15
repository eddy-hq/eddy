import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { SearchVideoWithDate } from '../../ytdlp';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
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

vi.mock('../../queue', () => ({
  redis: {},
  discoveryQueue: { add: vi.fn() },
  guardQueue: {},
  downloadQueue: {},
  thumbsQueue: {},
  deleteQueue: {},
}));

vi.mock('../../ytdlp', () => ({
  searchVideosWithDates: vi.fn(),
  flatPlaylistChannel: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { refreshCandidatePool, type UserInterestRow } from './intake';
import { searchVideosWithDates } from '../../ytdlp';

const USER_ID = '11111111-1111-7111-8111-111111111111';

const mockedSearch = vi.mocked(searchVideosWithDates);

function uploadDateStr(daysAgo: number): string {
  // yt-dlp upload_date is YYYYMMDD.
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function searchResult(opts: {
  videoId: string;
  title?: string;
  durationSecs?: number | null;
  uploadDate?: string | null;
  liveStatus?: string | null;
}): SearchVideoWithDate {
  return {
    videoId: opts.videoId,
    title: opts.title ?? `Title ${opts.videoId}`,
    channel: 'Some Channel',
    durationSecs: opts.durationSecs ?? 600,
    viewCount: 1000,
    uploadDate: opts.uploadDate ?? uploadDateStr(7),
    thumbnailUrl: `https://img/${opts.videoId}.jpg`,
    liveStatus: opts.liveStatus ?? null,
    url: `https://www.youtube.com/watch?v=${opts.videoId}`,
  };
}

function makeInterest(opts: {
  interestId: string;
  rank: number;
  searchTerms: string;
}): UserInterestRow {
  return {
    interest_id: opts.interestId,
    label: `interest-${opts.interestId}`,
    rank: opts.rank,
    expertise: 'comfortable',
    search_terms: opts.searchTerms,
  };
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());

  // The candidate_pool.interest_id column has a FK to interests(id), so
  // every interest_id our fake UserInterestRow uses must exist.
  const insertInterest = db.prepare(
    "INSERT INTO interests (id, label, search_terms, category, source) VALUES (?, ?, '[]', 'tech', 'seed')",
  );
  for (let i = 1; i <= 12; i++) insertInterest.run(`i${i}`, `interest-${i}`);
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  mockedSearch.mockReset();
});

describe('refreshCandidatePool — search budget', () => {
  it('top-3 interests get 2 terms each, ranks 4–10 get 1, rank 11+ skipped', () => {
    const interests: UserInterestRow[] = [];
    for (let i = 1; i <= 12; i++) {
      interests.push(makeInterest({
        interestId: `i${i}`,
        rank: i,
        searchTerms: JSON.stringify([`t${i}a`, `t${i}b`, `t${i}c`]),
      }));
    }

    mockedSearch.mockResolvedValue([]);

    return refreshCandidatePool(USER_ID, interests).then(() => {
      // Expected: ranks 1..3 → 2 calls each = 6; ranks 4..10 → 1 each = 7;
      // ranks 11..12 skipped (interestsToSearch.slice(0, 10)). Total 13.
      expect(mockedSearch).toHaveBeenCalledTimes(13);

      const calledTerms = mockedSearch.mock.calls.map((c) => c[0]);
      // First 3 interests contribute their first two terms.
      expect(calledTerms).toContain('t1a'); expect(calledTerms).toContain('t1b');
      expect(calledTerms).toContain('t2a'); expect(calledTerms).toContain('t2b');
      expect(calledTerms).toContain('t3a'); expect(calledTerms).toContain('t3b');
      // Rank 4 onwards contributes only its first term.
      expect(calledTerms).toContain('t4a');
      expect(calledTerms).not.toContain('t4b');
      expect(calledTerms).toContain('t10a');
      expect(calledTerms).not.toContain('t10b');
      // Ranks 11+ are not called at all.
      expect(calledTerms).not.toContain('t11a');
      expect(calledTerms).not.toContain('t12a');
    });
  });
});

describe('refreshCandidatePool — freshness window', () => {
  it('drops candidates older than 180 days before insert', async () => {
    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([
      searchResult({ videoId: 'fresh-vid', uploadDate: uploadDateStr(30) }),
      searchResult({ videoId: 'edge-vid', uploadDate: uploadDateStr(179) }),
      searchResult({ videoId: 'stale-vid', uploadDate: uploadDateStr(200) }),
      // Null upload date should not be dropped (daysSince → null).
      searchResult({ videoId: 'undated-vid', uploadDate: null }),
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    const rows = db.prepare(
      'SELECT external_id FROM candidate_pool ORDER BY external_id',
    ).all() as Array<{ external_id: string }>;
    const ids = rows.map((r) => r.external_id);

    expect(ids).toContain('fresh-vid');
    expect(ids).toContain('edge-vid');
    expect(ids).toContain('undated-vid');
    expect(ids).not.toContain('stale-vid');
    expect(added).toBe(3);
  });
});

describe('refreshCandidatePool — dedup', () => {
  it('does not insert a videoId already present in candidate_pool for the user', async () => {
    db.prepare(`
      INSERT INTO candidate_pool
        (candidate_id, user_id, content_type, source_type, url, external_id, status, created_at)
      VALUES (?, ?, 'video', 'interest_search', ?, ?, 'pending', ?)
    `).run(
      'existing-cand',
      USER_ID,
      'https://www.youtube.com/watch?v=already-in-pool',
      'already-in-pool',
      new Date().toISOString(),
    );

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];
    mockedSearch.mockResolvedValueOnce([
      searchResult({ videoId: 'already-in-pool' }),
      searchResult({ videoId: 'new-vid' }),
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    const rows = db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'interest_search'",
    ).all() as Array<{ external_id: string }>;
    const ids = rows.map((r) => r.external_id);

    // No second row for the already-pooled video.
    expect(ids.filter((id) => id === 'already-in-pool')).toHaveLength(1);
    expect(ids).toContain('new-vid');
    expect(added).toBe(1);
  });

  it('does not insert a videoId already present in requests for the user', async () => {
    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, youtube_id, status, requested_at)
      VALUES (?, ?, 'search', ?, ?, 'pending', ?)
    `).run(
      'req-1',
      USER_ID,
      'https://www.youtube.com/watch?v=req-vid',
      'req-vid',
      new Date().toISOString(),
    );

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];
    mockedSearch.mockResolvedValueOnce([
      searchResult({ videoId: 'req-vid' }),
      searchResult({ videoId: 'other-vid' }),
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    const ids = (db.prepare(
      'SELECT external_id FROM candidate_pool',
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);

    expect(ids).not.toContain('req-vid');
    expect(ids).toContain('other-vid');
    expect(added).toBe(1);
  });
});

describe('refreshCandidatePool — malformed search_terms', () => {
  it('treats invalid JSON as empty array, no crash, no calls for that interest', async () => {
    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: 'not-json-at-all' }),
      makeInterest({ interestId: 'i2', rank: 2, searchTerms: JSON.stringify(['ok-term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([
      searchResult({ videoId: 'ok-vid' }),
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    // Only i2's single 'ok-term' call happens (rank 2 ≤ 3 but only one
    // term in the array).
    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(mockedSearch.mock.calls[0]?.[0]).toBe('ok-term');
    expect(added).toBe(1);
  });

  it('treats non-array JSON (e.g. an object) as empty array', async () => {
    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: '{"not":"array"}' }),
    ];

    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(added).toBe(0);
  });
});
