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
    // #185 throttling knobs. Delays 0 so the spacing is a no-op in tests.
    DISCOVERY_SEARCH_LIMIT: 10,
    DISCOVERY_SEARCH_DELAY_MS: 0,
    DISCOVERY_SEARCH_JITTER_MS: 0,
    YTDLP_BOTDETECT_COOLDOWN_SECS: 2700,
    // Back-catalogue moratorium kill-switch (ADR-0012); enabled by default so
    // the seeder's existing behaviour is exercised. A dedicated test flips it.
    BACK_CATALOGUE_ENABLED: true,
  },
}));

// Bot-detection cooldown gate (#185). botDetectionCooldownMs is hoisted so
// individual tests can simulate an active cooldown; default is 0 (no cooldown).
const { mockCooldownMs } = vi.hoisted(() => ({ mockCooldownMs: vi.fn() }));
vi.mock('../../botdetect', () => ({
  botDetectionCooldownMs: mockCooldownMs,
  engageBotDetectionCooldown: vi.fn(),
  isBotDetectionError: vi.fn(() => false),
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
  seedBackCatalogCandidates,
  type UserInterestRow,
} from './intake';
import { searchVideosWithDates, flatPlaylistChannel } from '../../ytdlp';

const USER_ID = '11111111-1111-7111-8111-111111111111';

const mockedSearch = vi.mocked(searchVideosWithDates);
const mockedPlaylist = vi.mocked(flatPlaylistChannel);

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
  channel?: string;
  channelId?: string;
}): SearchVideoWithDate {
  return {
    videoId: opts.videoId,
    title: opts.title ?? `Title ${opts.videoId}`,
    channel: opts.channel ?? 'Some Channel',
    channelId: opts.channelId ?? '',
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
  mockCooldownMs.mockReset();
  mockCooldownMs.mockResolvedValue(0); // no cooldown unless a test opts in
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

describe('refreshCandidatePool — bot-detection cooldown + search depth (#185)', () => {
  it('skips every search and returns 0 while a cooldown is active', async () => {
    mockCooldownMs.mockResolvedValue(60_000); // cooldown armed

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    const added = await refreshCandidatePool(USER_ID, interests);

    expect(added).toBe(0);
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it('passes the configured ytsearch depth to the search', async () => {
    mockedSearch.mockResolvedValue([]);

    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
    ];

    await refreshCandidatePool(USER_ID, interests);

    // DISCOVERY_SEARCH_LIMIT in the mock config is 10 (was a hardcoded 20).
    expect(mockedSearch).toHaveBeenCalledWith('term', 10);
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

  it('skips an interest with empty search_terms (broad/vocabulary-only, ADR-0008)', async () => {
    // A too-broad interest persisted as '[]' by the specificity-aware worker
    // serves as scoring vocabulary but must never generate a ytsearch query.
    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: '[]' }),
      makeInterest({ interestId: 'i2', rank: 2, searchTerms: JSON.stringify(['ok-term']) }),
    ];

    mockedSearch.mockResolvedValueOnce([searchResult({ videoId: 'ok-vid' })]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(mockedSearch.mock.calls[0]?.[0]).toBe('ok-term');
    expect(added).toBe(1);
  });

  it('skips an interest still on the reconcile sentinel (pending regeneration, issue #157)', async () => {
    // Migration 033 resets existing rows to this sentinel; until the startup
    // reconcile re-runs generation the row must read as no-terms, never as a
    // literal query string.
    const interests: UserInterestRow[] = [
      makeInterest({ interestId: 'i1', rank: 1, searchTerms: '__pending_specificity__' }),
    ];

    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

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
        channelId: '',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/fresh.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=fresh-vid',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

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
        channelId: '',
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
        channelId: '',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/other.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=other-vid',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

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
        channelId: '',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/incoming.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=incoming-vid',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

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
        channelId: '',
        durationSecs: 600,
        viewCount: 1000,
        uploadDate: uploadDateStr(7),
        thumbnailUrl: 'https://img/still.jpg',
        liveStatus: null,
        url: 'https://www.youtube.com/watch?v=still-fresh',
      },
    ]);
    mockedSearch.mockResolvedValue([]);

    const added = await refreshCandidatePool(USER_ID, interests);

    const ids = (db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'interest_search'",
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);

    expect(ids).toContain('still-fresh');
    expect(added).toBe(1);
  });
});

// ── ADR-0009: interest search no longer gates on person-sourced supply ───────
//
// The #149 gate (skip / partial / full based on a person-sourced count) is
// removed. refreshCandidatePool now always runs at full budget to fill the
// delighter bucket. countPersonSourcedForRefresh and RefreshOptions are gone.

describe('refreshCandidatePool — gate removed, always full budget (ADR-0009)', () => {
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

  it('runs the full 13-query budget even with ample person-sourced supply present', async () => {
    // Seed plenty of live person_backcatalog candidates — under the old gate
    // this would have skipped interest search entirely. It must now run in full.
    const insert = db.prepare(`
      INSERT INTO candidate_pool
        (candidate_id, user_id, content_type, source_type, url, external_id, status, created_at)
      VALUES (?, ?, 'video', 'person_backcatalog', ?, ?, 'pending', ?)
    `);
    const now = new Date().toISOString();
    for (let i = 0; i < 30; i++) {
      insert.run(`pc-${i}`, USER_ID, `https://www.youtube.com/watch?v=pc-${i}`, `pc-${i}`, now);
    }

    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    await refreshCandidatePool(USER_ID, interests);

    // Full budget mirrors the historical full run: top-3 × 2 + ranks 4–10 × 1.
    expect(mockedSearch).toHaveBeenCalledTimes(13);
  });

  it('runs the full budget on an empty pool too', async () => {
    const interests = buildInterests(10);
    mockedSearch.mockResolvedValue([]);

    await refreshCandidatePool(USER_ID, interests);

    expect(mockedSearch).toHaveBeenCalledTimes(13);
  });
});

// ── ADR-0009: back-catalogue dedup switch (seen_videos → isDuplicateCandidate)
//
// The discovery job polls subscriptions first, and the poller writes every
// RSS-window video into seen_videos. The back-catalogue seeder must therefore
// dedup against the pool + requests (isDuplicateCandidate), NOT seen_videos —
// otherwise poll-first would starve the back catalogue of a new follow's
// recent uploads.

describe('seedBackCatalogCandidates — dedup switch to isDuplicateCandidate', () => {
  const PERSON_ID = 'person-bc-1';
  const CHANNEL_ID = 'UCbackcatchannel1xxxxxx';

  function setupFollowedChannel(): void {
    db.prepare(
      `INSERT OR REPLACE INTO people (person_id, display_name, created_at) VALUES (?, ?, ?)`,
    ).run(PERSON_ID, 'Back-cat Creator', new Date().toISOString());
    db.prepare(
      `INSERT OR REPLACE INTO person_outputs
         (output_id, person_id, output_type, external_id, active, last_polled)
       VALUES (?, ?, 'youtube', ?, 1, NULL)`,
    ).run('output-bc-1', PERSON_ID, CHANNEL_ID);
    db.prepare(
      `INSERT OR REPLACE INTO followed_people
         (user_id, person_id, trust_weight, followed_at, followed_via)
       VALUES (?, ?, 1.0, ?, 'manual')`,
    ).run(USER_ID, PERSON_ID, new Date().toISOString());
  }

  beforeEach(() => {
    db.exec('DELETE FROM seen_videos');
    db.exec('DELETE FROM followed_people');
    db.exec('DELETE FROM person_outputs');
    db.exec('DELETE FROM people');
    db.exec('DELETE FROM channel_interest_links');
    mockedPlaylist.mockReset();
  });

  it('does NOT exclude a video merely present in seen_videos (poll-first ledger)', async () => {
    setupFollowedChannel();
    // The poller marked this video seen but did NOT create a candidate for it
    // (e.g. it was a first-poll catch-up item). The back-catalogue seeder must
    // still be free to mine it.
    db.prepare(
      `INSERT INTO seen_videos (channel_id, video_id, seen_at) VALUES (?, ?, ?)`,
    ).run(CHANNEL_ID, 'seen-but-not-candidate', new Date().toISOString());

    mockedPlaylist.mockResolvedValue([
      { videoId: 'seen-but-not-candidate', title: 'Seen yet mineable', durationSecs: 600, liveStatus: null },
    ]);

    const added = await seedBackCatalogCandidates(USER_ID);

    expect(added).toBe(1);
    const row = db.prepare(
      "SELECT source_type FROM candidate_pool WHERE external_id = ?",
    ).get('seen-but-not-candidate') as { source_type: string } | undefined;
    expect(row?.source_type).toBe('person_backcatalog');
  });

  it('DOES exclude a video already a candidate in the pool (isDuplicateCandidate)', async () => {
    setupFollowedChannel();
    // The poller turned this video into a subscription candidate this run —
    // it must not be re-added as a back-catalogue candidate.
    db.prepare(`
      INSERT INTO candidate_pool
        (candidate_id, user_id, content_type, source_type, url, external_id, status, created_at)
      VALUES (?, ?, 'video', 'subscription', ?, ?, 'pending', ?)
    `).run(
      'existing-sub', USER_ID,
      'https://www.youtube.com/watch?v=already-candidate', 'already-candidate',
      new Date().toISOString(),
    );

    mockedPlaylist.mockResolvedValue([
      { videoId: 'already-candidate', title: 'Already a candidate', durationSecs: 600, liveStatus: null },
      { videoId: 'genuinely-new', title: 'Genuinely new back-cat', durationSecs: 600, liveStatus: null },
    ]);

    const added = await seedBackCatalogCandidates(USER_ID);

    // Only the genuinely-new video is added; the existing candidate is skipped.
    expect(added).toBe(1);
    const ids = (db.prepare(
      "SELECT external_id FROM candidate_pool WHERE source_type = 'person_backcatalog'",
    ).all() as Array<{ external_id: string }>).map((r) => r.external_id);
    expect(ids).toEqual(['genuinely-new']);
  });

  it('DOES exclude a video already requested for the user', async () => {
    setupFollowedChannel();
    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, youtube_id, status, requested_at)
      VALUES (?, ?, 'channel_subscription', ?, ?, 'ready', ?)
    `).run(
      'req-existing', USER_ID,
      'https://www.youtube.com/watch?v=already-requested', 'already-requested',
      new Date().toISOString(),
    );

    mockedPlaylist.mockResolvedValue([
      { videoId: 'already-requested', title: 'Already requested', durationSecs: 600, liveStatus: null },
    ]);

    const added = await seedBackCatalogCandidates(USER_ID);

    expect(added).toBe(0);
  });

  it('skips back-catalogue mining entirely while a bot-detection cooldown is active (#185)', async () => {
    setupFollowedChannel();
    mockCooldownMs.mockResolvedValue(60_000); // cooldown armed

    const added = await seedBackCatalogCandidates(USER_ID);

    expect(added).toBe(0);
    // The cooldown short-circuits before any flat-playlist fetch.
    expect(mockedPlaylist).not.toHaveBeenCalled();
  });

  it('halts entirely under the back-catalogue moratorium (ADR-0012)', async () => {
    setupFollowedChannel();
    mockConfig.BACK_CATALOGUE_ENABLED = false;
    mockedPlaylist.mockResolvedValue([
      { videoId: 'would-be-mined', title: 'Blocked by moratorium', durationSecs: 600, liveStatus: null },
    ]);

    try {
      const added = await seedBackCatalogCandidates(USER_ID);
      expect(added).toBe(0);
      // The kill-switch short-circuits before any flat-playlist fetch (and
      // before the cooldown check), so no yt-dlp fan-out occurs.
      expect(mockedPlaylist).not.toHaveBeenCalled();
    } finally {
      mockConfig.BACK_CATALOGUE_ENABLED = true;
    }
  });
});

describe('Blocked channels at intake', () => {
  const ADULT_ID = '22222222-2222-7222-8222-222222222222';
  const BLOCKED_ID = 'UCblockedblockedblocked0';
  const OTHER_ID = 'UCotherotherotherother00';
  const PERSON_ID = 'person-blocked-1';

  const interests = (): UserInterestRow[] => [
    makeInterest({ interestId: 'i1', rank: 1, searchTerms: JSON.stringify(['term']) }),
  ];

  beforeAll(() => {
    db.prepare(
      'INSERT OR IGNORE INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(ADULT_ID, 'Parent1', 'parent', 0, new Date().toISOString());
  });

  beforeEach(() => {
    db.exec('DELETE FROM blocked_channels');
    db.exec('DELETE FROM followed_people');
    db.exec('DELETE FROM person_outputs');
    db.exec('DELETE FROM people');
    mockedPlaylist.mockReset();
    db.prepare(
      'INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)',
    ).run(BLOCKED_ID, 'Placeholder blocked channel', ADULT_ID, new Date().toISOString());
  });

  function poolIds(userId: string): string[] {
    return (db.prepare('SELECT external_id FROM candidate_pool WHERE user_id = ? ORDER BY external_id')
      .all(userId) as Array<{ external_id: string }>).map((r) => r.external_id);
  }

  it("drops a blocked channel's search results for a kid and records the channel id on the rest", async () => {
    mockedSearch.mockResolvedValue([
      searchResult({ videoId: 'blocked-vid', channel: 'Placeholder blocked channel', channelId: BLOCKED_ID }),
      searchResult({ videoId: 'other-vid', channel: 'Placeholder other channel', channelId: OTHER_ID }),
    ]);

    const added = await refreshCandidatePool(USER_ID, interests());

    expect(added).toBe(1);
    expect(poolIds(USER_ID)).toEqual(['other-vid']);
    const row = db.prepare('SELECT channel_id FROM candidate_pool WHERE external_id = ?').get('other-vid') as { channel_id: string };
    expect(row.channel_id).toBe(OTHER_ID);
  });

  it('falls back to the display name when a result carries no channel id', async () => {
    mockedSearch.mockResolvedValue([
      searchResult({ videoId: 'nameless-id', channel: 'Placeholder blocked channel', channelId: '' }),
    ]);

    expect(await refreshCandidatePool(USER_ID, interests())).toBe(0);
  });

  it("leaves an adult's intake alone", async () => {
    mockedSearch.mockResolvedValue([
      searchResult({ videoId: 'blocked-vid', channel: 'Placeholder blocked channel', channelId: BLOCKED_ID }),
    ]);

    expect(await refreshCandidatePool(ADULT_ID, interests())).toBe(1);
    expect(poolIds(ADULT_ID)).toEqual(['blocked-vid']);
  });

  it("skips a followed, blocked channel's back catalogue for a kid but keeps the follow", async () => {
    db.prepare('INSERT INTO people (person_id, display_name, created_at) VALUES (?, ?, ?)')
      .run(PERSON_ID, 'Placeholder blocked channel', new Date().toISOString());
    db.prepare(
      `INSERT INTO person_outputs (output_id, person_id, output_type, external_id, active, last_polled)
       VALUES (?, ?, 'youtube', ?, 1, NULL)`,
    ).run('output-blocked-1', PERSON_ID, BLOCKED_ID);
    db.prepare(
      `INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
       VALUES (?, ?, 1.0, ?, 'manual')`,
    ).run(USER_ID, PERSON_ID, new Date().toISOString());
    mockedPlaylist.mockResolvedValue([
      { videoId: 'backcat-vid', title: 'Placeholder title', durationSecs: 600, liveStatus: null },
    ]);

    expect(await seedBackCatalogCandidates(USER_ID)).toBe(0);
    expect(mockedPlaylist).not.toHaveBeenCalled();
    expect(db.prepare('SELECT 1 FROM followed_people WHERE user_id = ? AND person_id = ?').get(USER_ID, PERSON_ID)).toBeDefined();
  });
});
