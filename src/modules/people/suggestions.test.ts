import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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
  interestsQueue: { add: vi.fn() },
  guardQueue: { add: vi.fn() },
  discoveryQueue: { add: vi.fn() },
  downloadQueue: { add: vi.fn() },
  thumbsQueue: { add: vi.fn() },
  deleteQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { getFollowSuggestions, dismissFollowSuggestion, buildSuggestionReason } from './suggestions';

const KID = '11111111-1111-7111-8111-111111111111';
const PARENT = '22222222-2222-7222-8222-222222222222';

const FOOTBALL = 'football';
const GAMING = 'gaming';

const PERSON_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PERSON_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const PERSON_C = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const CHANNEL_A = 'UCaaa';
const CHANNEL_B = 'UCbbb';
const CHANNEL_C = 'UCccc';

function follow(userId: string, personId: string): void {
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, 1.0, ?, 'manual')
  `).run(userId, personId, new Date().toISOString());
}

function link(channelId: string, interestId: string, confidence: number): void {
  db.prepare(`
    INSERT INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at)
    VALUES (?, ?, ?, ?)
  `).run(channelId, interestId, confidence, new Date().toISOString());
}

function declare(userId: string, interestId: string, rank: number): void {
  db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
    VALUES (?, ?, ?, 'comfortable', 1, ?)
  `).run(userId, interestId, rank, new Date().toISOString());
}

let requestSeq = 0;

// Seed a request for the given user/channel with optional watched/saved
// timestamps. Each request gets a distinct id and youtube_id so distinct-count
// aggregation behaves like production.
function request(
  userId: string,
  channelId: string,
  opts: { watchedAt?: string; savedAt?: string } = {},
): void {
  requestSeq += 1;
  const id = `req-${requestSeq}`;
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, youtube_channel_id, status, requested_at, watched_at, saved_at)
    VALUES (?, ?, 'search', ?, ?, ?, 'ready', ?, ?, ?)
  `).run(
    id,
    userId,
    `https://youtu.be/vid-${requestSeq}`,
    `vid-${requestSeq}`,
    channelId,
    new Date().toISOString(),
    opts.watchedAt ?? null,
    opts.savedAt ?? null,
  );
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(KID, 'Boy1', 'kid', 12, now);
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(PARENT, 'Parent', 'parent', 99, now);

  db.prepare('INSERT INTO interests (id, label, category) VALUES (?, ?, ?)')
    .run(FOOTBALL, 'football', 'sport');
  db.prepare('INSERT INTO interests (id, label, category) VALUES (?, ?, ?)')
    .run(GAMING, 'gaming', 'games');

  for (const [pid, cid, name] of [
    [PERSON_A, CHANNEL_A, 'Creator A'],
    [PERSON_B, CHANNEL_B, 'Creator B'],
    [PERSON_C, CHANNEL_C, 'Creator C'],
  ] as const) {
    db.prepare('INSERT INTO people (person_id, display_name, person_type, photo_url, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(pid, name, 'creator', `https://photo/${cid}`, now);
    db.prepare(`
      INSERT INTO person_outputs (output_id, person_id, output_type, fetcher_type, external_id, active)
      VALUES (?, ?, 'youtube', 'rss', ?, 1)
    `).run(`out-${pid}`, pid, cid);
  }
});

beforeEach(() => {
  db.exec('DELETE FROM followed_people');
  db.exec('DELETE FROM channel_interest_links');
  db.exec('DELETE FROM user_interests');
  db.exec('DELETE FROM follow_suggestion_dismissals');
  db.exec('DELETE FROM requests');
});

describe('buildSuggestionReason', () => {
  it('formats both counts with a middot separator', () => {
    expect(buildSuggestionReason(4, 2, ['football'])).toBe('Watched 4 · saved 2 — football');
  });

  it('formats watched-only', () => {
    expect(buildSuggestionReason(4, 0, ['football'])).toBe('Watched 4 — football');
  });

  it('formats saved-only', () => {
    expect(buildSuggestionReason(0, 2, ['football'])).toBe('Saved 2 — football');
  });

  it('comma-joins multiple labels', () => {
    expect(buildSuggestionReason(4, 0, ['football', 'gaming'])).toBe('Watched 4 — football, gaming');
  });
});

describe('getFollowSuggestions — engaged-not-followed listing', () => {
  it('lists an engaged-not-followed channel mapping to a declared interest', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    const result = getFollowSuggestions(KID);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channelId: CHANNEL_A,
      displayName: 'Creator A',
      photoUrl: 'https://photo/UCaaa',
      watchedCount: 1,
      savedCount: 0,
      reason: 'Watched 1 — football',
    });
    expect(result[0].interests).toEqual([{ id: FOOTBALL, label: 'football' }]);
  });

  it('counts a saved-only engagement', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    request(KID, CHANNEL_A, { savedAt: '2026-05-01T00:00:00.000Z' });

    const result = getFollowSuggestions(KID);
    expect(result[0]).toMatchObject({ watchedCount: 0, savedCount: 1, reason: 'Saved 1 — football' });
  });

  it('returns an empty set for a user with no engagement', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    expect(getFollowSuggestions(KID)).toEqual([]);
  });

  it('does not leak another user\'s engagement', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    request(PARENT, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    expect(getFollowSuggestions(KID)).toEqual([]);
  });
});

describe('getFollowSuggestions — alignment hard-filter', () => {
  it('excludes a channel with engagement but no declared-interest link', () => {
    // Engaged, but the channel has no channel_interest_links row at all.
    declare(KID, FOOTBALL, 1);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    expect(getFollowSuggestions(KID)).toEqual([]);
  });

  it('excludes a channel linked only to a NON-declared interest', () => {
    // User declares football; channel A is linked only to gaming. No overlap.
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, GAMING, 1.0);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    expect(getFollowSuggestions(KID)).toEqual([]);
  });

  it('includes a channel that maps to at least one declared interest', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    link(CHANNEL_A, GAMING, 1.0); // gaming not declared — ignored
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    const result = getFollowSuggestions(KID);
    expect(result).toHaveLength(1);
    expect(result[0].interests).toEqual([{ id: FOOTBALL, label: 'football' }]);
  });
});

describe('getFollowSuggestions — exclusions', () => {
  it('excludes an already-followed channel', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });
    follow(KID, PERSON_A);

    expect(getFollowSuggestions(KID)).toEqual([]);
  });

  it('excludes a dismissed channel and never re-suggests it', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    expect(getFollowSuggestions(KID)).toHaveLength(1);

    dismissFollowSuggestion(KID, CHANNEL_A);
    expect(getFollowSuggestions(KID)).toEqual([]);
    // Re-derive: still excluded.
    expect(getFollowSuggestions(KID)).toEqual([]);
  });

  it('dismiss is idempotent', () => {
    dismissFollowSuggestion(KID, CHANNEL_A);
    expect(() => dismissFollowSuggestion(KID, CHANNEL_A)).not.toThrow();
  });
});

describe('getFollowSuggestions — multi-interest labelling', () => {
  it('attaches all matching declared-interest labels', () => {
    declare(KID, FOOTBALL, 1);
    declare(KID, GAMING, 2);
    link(CHANNEL_A, FOOTBALL, 1.0);
    link(CHANNEL_A, GAMING, 1.0);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    const result = getFollowSuggestions(KID);
    expect(result[0].interests.map((i) => i.id).sort()).toEqual([FOOTBALL, GAMING].sort());
    // Reason comma-joins the labels.
    expect(result[0].reason.startsWith('Watched 1 — ')).toBe(true);
    expect(result[0].reason).toContain('football');
    expect(result[0].reason).toContain('gaming');
  });
});

describe('getFollowSuggestions — ranking', () => {
  it('ranks by distinct watched+saved request count DESC', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    link(CHANNEL_B, FOOTBALL, 1.0);

    // A: 1 engaged request. B: 3 engaged requests → B ranks first.
    request(KID, CHANNEL_A, { watchedAt: '2026-05-10T00:00:00.000Z' });
    request(KID, CHANNEL_B, { watchedAt: '2026-05-01T00:00:00.000Z' });
    request(KID, CHANNEL_B, { watchedAt: '2026-05-02T00:00:00.000Z' });
    request(KID, CHANNEL_B, { savedAt: '2026-05-03T00:00:00.000Z' });

    const result = getFollowSuggestions(KID);
    expect(result.map((r) => r.channelId)).toEqual([CHANNEL_B, CHANNEL_A]);
  });

  it('breaks an engagement-count tie by most-recent engagement DESC', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);
    link(CHANNEL_B, FOOTBALL, 1.0);

    // Both have one engaged request; B's is more recent → B ranks first.
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });
    request(KID, CHANNEL_B, { savedAt: '2026-05-20T00:00:00.000Z' });

    const result = getFollowSuggestions(KID);
    expect(result.map((r) => r.channelId)).toEqual([CHANNEL_B, CHANNEL_A]);
  });

  it('caps the list at 5', () => {
    declare(KID, FOOTBALL, 1);
    // Six distinct channels would qualify, but only A/B/C have person rows
    // seeded; reuse them plus extra channels with their own people.
    const extra = [
      ['dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'UCddd', 'Creator D'],
      ['eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'UCeee', 'Creator E'],
      ['ffffffff-ffff-7fff-8fff-ffffffffffff', 'UCfff', 'Creator F'],
    ] as const;
    const now = new Date().toISOString();
    for (const [pid, cid, name] of extra) {
      db.prepare('INSERT OR IGNORE INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)')
        .run(pid, name, 'creator', now);
      db.prepare('INSERT OR IGNORE INTO person_outputs (output_id, person_id, output_type, fetcher_type, external_id, active) VALUES (?, ?, \'youtube\', \'rss\', ?, 1)')
        .run(`out-${pid}`, pid, cid);
    }
    const channels = [CHANNEL_A, CHANNEL_B, CHANNEL_C, 'UCddd', 'UCeee', 'UCfff'];
    channels.forEach((cid, idx) => {
      link(cid, FOOTBALL, 1.0);
      request(KID, cid, { watchedAt: `2026-05-${String(idx + 1).padStart(2, '0')}T00:00:00.000Z` });
    });

    const result = getFollowSuggestions(KID);
    expect(result).toHaveLength(5);
  });
});
