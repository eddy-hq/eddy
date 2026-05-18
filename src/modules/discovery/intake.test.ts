import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { SearchVideoWithDate } from '../../ytdlp';

// Mutable so individual tests can re-tune the threshold without re-mocking.
// Wrapped in vi.hoisted so the binding is available to vi.mock, which is
// itself hoisted above the rest of the module.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'gemma4:e4b',
    DISCOVERY_CHANNEL_DISMISS_THRESHOLD: 3,
  },
}));

vi.mock('../../config', () => ({
  config: mockConfig,
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
import {
  refreshCandidatePool,
  countPersonSourcedForRefresh,
  type UserInterestRow,
} from './intake';
import { searchVideosWithDates } from '../../ytdlp';

const USER_ID = '11111111-1111-7111-8111-111111111111';

const mockedSearch = vi.mocked(searchVideosWithDates);

// Tests that aren't exercising the gating use threshold=0, which preserves
// the historical full-budget behaviour (issue #149). The dedicated gating
// suite below sets threshold>0 explicitly.
const FULL_RUN = { personSourcedCount: 0, threshold: 0 } as const;

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
  mockConfig.DISCOVERY_CHANNEL_DISMISS_THRESHOLD = 3;
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

    return refreshCandidatePool(USER_ID, interests, FULL_RUN).then(() => {
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

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

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

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

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

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

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

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

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

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(added).toBe(0);
  });
});

describe('refreshCandidatePool — channel dismissal filter (issue #147)', () => {
  // Seed `count` distinct dismissed candidate_pool rows for the given channel.
  function seedDismissedCandidates(channel: string, count: number): void {
    const insert = db.prepare(`
      INSERT INTO candidate_pool
        (candidate_id, user_id, content_type, source_type, url, external_id,
         channel, status, created_at)
      VALUES (?, ?, 'video', 'interest_search', ?, ?, ?, 'dismissed', ?)
    `);
    const now = new Date().toISOString();
    for (let i = 0; i < count; i++) {
      const vid = `dismissed-${channel.replace(/\s+/g, '-')}-${i}`;
      insert.run(
        `cand-${vid}`,
        USER_ID,
        `https://www.youtube.com/watch?v=${vid}`,
        vid,
        channel,
        now,
      );
    }
  }

  it('below threshold: candidate from the same channel is still enqueued', async () => {
    seedDismissedCandidates('Quiet Channel', 2); // threshold default is 3

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([
      {
        videoId: 'fresh-vid',
        title: 'Title',
        channel: 'Quiet Channel',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/fresh.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=fresh-vid',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

    const ids = (db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'interest_search'",
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);

    expect(ids).toContain('fresh-vid');
    expect(added).toBe(1);
  });

  it('at threshold: candidate from over-dismissed channel is filtered before insert', async () => {
    seedDismissedCandidates('Noisy Channel', 3); // exactly at default threshold

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([
      {
        videoId: 'noisy-vid',
        title: 'Title',
        channel: 'Noisy Channel',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/noisy.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=noisy-vid',
      },
      {
        videoId: 'other-vid',
        title: 'Title',
        channel: 'Other Channel',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/other.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=other-vid',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

    const ids = (db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'interest_search'",
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);

    expect(ids).not.toContain('noisy-vid');
    expect(ids).toContain('other-vid');
    expect(added).toBe(1);
  });

  it('counts player-side deletes (requests.status=deleted) toward the channel total', async () => {
    // 2 pre-play dismisses + 1 player-side delete → 3, reaches threshold.
    seedDismissedCandidates('Mixed Channel', 2);
    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, youtube_id, channel, status, requested_at)
      VALUES (?, ?, 'search', ?, ?, ?, 'deleted', ?)
    `).run(
      'req-deleted-1',
      USER_ID,
      'https://www.youtube.com/watch?v=deleted-vid-1',
      'deleted-vid-1',
      'Mixed Channel',
      new Date().toISOString(),
    );

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([
      {
        videoId: 'incoming-vid',
        title: 'Title',
        channel: 'Mixed Channel',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/incoming.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=incoming-vid',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

    const ids = (db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'interest_search'",
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);

    expect(ids).not.toContain('incoming-vid');
    expect(added).toBe(0);
  });

  it('threshold = 0 disables the filter entirely (no-op even at high counts)', async () => {
    mockConfig.DISCOVERY_CHANNEL_DISMISS_THRESHOLD = 0;
    seedDismissedCandidates('Heavily Dismissed', 10);

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([
      {
        videoId: 'still-fresh',
        title: 'Title',
        channel: 'Heavily Dismissed',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/still.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=still-fresh',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests, FULL_RUN);

    const ids = (db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'interest_search'",
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);

    expect(ids).toContain('still-fresh');
    expect(added).toBe(1);
  });
});

// ── issue #149: interest search demoted to gap-filler ────────────────────────
//
// Brief §17 says person-sourced material is the primary discovery signal and
// interest search only runs when person-sourced candidates are thin. These
// tests exercise the skip / full / partial decisions through the public
// refreshCandidatePool entry point, asserting on the yt-dlp call count
// rather than internal state — the contract the rest of the system cares
// about is "how many search queries did we run today?".

describe('refreshCandidatePool — person-sourced gating (issue #149)', () => {
  function buildInterests(count: number): UserInterestRow[] {
    const interests: UserInterestRow[] = [];
    for (let i = 1; i <= count; i++) {
      interests.push(makeInterest({
        interestId: `i${i}`,
        rank: i,
        searchTerms: JSON.stringify([`t${i}a`, `t${i}b`, `t${i}c`]),
      }));
    }
    return interests;
  }

  it('person-sourced count meets threshold → zero yt-dlp interest calls', async () => {
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests, {
      personSourcedCount: 5,
      threshold: 5,
    });

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(added).toBe(0);
  });

  it('person-sourced count exceeds threshold → zero yt-dlp interest calls', async () => {
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    await refreshCandidatePool(USER_ID, interests, {
      personSourcedCount: 20,
      threshold: 15,
    });

    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it('person-sourced count is zero → full search budget (13 calls)', async () => {
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    await refreshCandidatePool(USER_ID, interests, {
      personSourcedCount: 0,
      threshold: 15,
    });

    // Full budget mirrors the historical behaviour: top-3 × 2 + ranks 4–10 × 1.
    expect(mockedSearch).toHaveBeenCalledTimes(13);
  });

  it('person-sourced count is half the threshold → partial budget, top-rank prefix', async () => {
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    // Half-deficit against an adult threshold: ceil(13 * 8 / 15) = 7.
    await refreshCandidatePool(USER_ID, interests, {
      personSourcedCount: 7,
      threshold: 15,
    });

    expect(mockedSearch).toHaveBeenCalledTimes(7);

    const calledTerms = mockedSearch.mock.calls.map((c) => c[0]);
    // Plan ordering puts top-3 interests' two terms first (6 queries),
    // then rank 4's first term — exactly 7 with this budget.
    expect(calledTerms).toEqual(['t1a', 't1b', 't2a', 't2b', 't3a', 't3b', 't4a']);
    expect(calledTerms).not.toContain('t5a');
  });

  it('small shortfall (2-of-15) gets a small budget, not the full 13', async () => {
    // Issue #149 acceptance: "don't pull 13 queries to fill a 2-item shortfall".
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    // ceil(13 * 2 / 15) = 2.
    await refreshCandidatePool(USER_ID, interests, {
      personSourcedCount: 13,
      threshold: 15,
    });

    expect(mockedSearch).toHaveBeenCalledTimes(2);
  });

  it('threshold = 0 disables gating: full budget even with plenty of person sources', async () => {
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    await refreshCandidatePool(USER_ID, interests, {
      personSourcedCount: 9999,
      threshold: 0,
    });

    expect(mockedSearch).toHaveBeenCalledTimes(13);
  });
});

describe('countPersonSourcedForRefresh (issue #149)', () => {
  function insertPoolRow(opts: {
    candidateId: string;
    sourceType: 'interest_search' | 'person_backcatalog' | 'person_recommendation';
    status: string;
    createdAt?: string;
  }): void {
    db.prepare(`
      INSERT INTO candidate_pool
        (candidate_id, user_id, content_type, source_type, url, external_id,
         status, created_at)
      VALUES (?, ?, 'video', ?, ?, ?, ?, ?)
    `).run(
      opts.candidateId,
      USER_ID,
      opts.sourceType,
      `https://www.youtube.com/watch?v=${opts.candidateId}`,
      opts.candidateId,
      opts.status,
      opts.createdAt ?? new Date().toISOString(),
    );
  }

  function insertRequest(opts: {
    requestId: string;
    source: string;
    requestedAt?: string;
  }): void {
    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, youtube_id, status, requested_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      opts.requestId,
      USER_ID,
      opts.source,
      `https://www.youtube.com/watch?v=${opts.requestId}`,
      opts.requestId,
      opts.requestedAt ?? new Date().toISOString(),
    );
  }

  it('counts person_backcatalog and person_recommendation pool rows', () => {
    insertPoolRow({ candidateId: 'bc-1', sourceType: 'person_backcatalog', status: 'pending' });
    insertPoolRow({ candidateId: 'bc-2', sourceType: 'person_backcatalog', status: 'scored' });
    insertPoolRow({ candidateId: 'pr-1', sourceType: 'person_recommendation', status: 'pending' });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(3);
  });

  it('excludes interest_search pool rows', () => {
    insertPoolRow({ candidateId: 'is-1', sourceType: 'interest_search', status: 'pending' });
    insertPoolRow({ candidateId: 'bc-1', sourceType: 'person_backcatalog', status: 'pending' });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(1);
  });

  it('excludes dismissed and guard_rejected pool rows', () => {
    insertPoolRow({ candidateId: 'bc-1', sourceType: 'person_backcatalog', status: 'pending' });
    insertPoolRow({ candidateId: 'bc-2', sourceType: 'person_backcatalog', status: 'dismissed' });
    insertPoolRow({ candidateId: 'bc-3', sourceType: 'person_backcatalog', status: 'guard_rejected' });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(1);
  });

  it('excludes spent statuses (requested, surfaced) so historical picks do not look like fresh supply', () => {
    // Round-1 codex finding: a user who has surfaced/requested enough
    // person-sourced items in the past would have person_count above the
    // threshold indefinitely, suppressing interest search even when no
    // fresh person-sourced material arrived this refresh.
    insertPoolRow({ candidateId: 'bc-live', sourceType: 'person_backcatalog', status: 'pending' });
    insertPoolRow({ candidateId: 'bc-spent-req', sourceType: 'person_backcatalog', status: 'requested' });
    insertPoolRow({ candidateId: 'bc-spent-surf', sourceType: 'person_backcatalog', status: 'surfaced' });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(1);
  });

  it('counts only pool rows created within the last 24h', () => {
    insertPoolRow({ candidateId: 'bc-fresh', sourceType: 'person_backcatalog', status: 'pending' });
    insertPoolRow({
      candidateId: 'bc-stale',
      sourceType: 'person_backcatalog',
      status: 'pending',
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(1);
  });

  it('counts channel_subscription requests within 24h', () => {
    insertRequest({ requestId: 'rss-fresh', source: 'channel_subscription' });
    // Two days ago — outside the 24h window.
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    insertRequest({ requestId: 'rss-stale', source: 'channel_subscription', requestedAt: oldIso });
    // Other request sources don't count.
    insertRequest({ requestId: 'share-1', source: 'share_sheet' });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(1);
  });

  it('returns zero when nothing is person-sourced', () => {
    insertPoolRow({ candidateId: 'is-1', sourceType: 'interest_search', status: 'pending' });
    insertRequest({ requestId: 'share-1', source: 'share_sheet' });

    expect(countPersonSourcedForRefresh(USER_ID)).toBe(0);
  });
});
