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

const { guardAdd } = vi.hoisted(() => ({ guardAdd: vi.fn() }));
vi.mock('../../queue', () => ({
  redis: {},
  interestsQueue: { add: vi.fn() },
  guardQueue: { add: guardAdd },
  discoveryQueue: { add: vi.fn() },
  downloadQueue: { add: vi.fn() },
  thumbsQueue: { add: vi.fn() },
  deleteQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { KID_INTEREST_EVAL_JOB } from '../guard/index';
import {
  getInferredInterests,
  suppressInferredInterest,
  keepInferredInterest,
} from './inferred';

const KID = '11111111-1111-7111-8111-111111111111';
const PARENT = '22222222-2222-7222-8222-222222222222';

// Two interests in the shared vocabulary.
const MINECRAFT = 'minecraft';
const PROGRAMMING = 'programming';

// People + their youtube channel outputs.
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
    .run(MINECRAFT, 'Minecraft', 'gaming');
  db.prepare('INSERT INTO interests (id, label, category) VALUES (?, ?, ?)')
    .run(PROGRAMMING, 'Programming', 'tech');

  for (const [pid, cid] of [
    [PERSON_A, CHANNEL_A],
    [PERSON_B, CHANNEL_B],
    [PERSON_C, CHANNEL_C],
  ] as const) {
    db.prepare('INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)')
      .run(pid, 'Channel', 'creator', now);
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
  db.exec('DELETE FROM inferred_interest_suppressions');
  guardAdd.mockReset();
  guardAdd.mockResolvedValue(undefined);
});

describe('getInferredInterests — derive', () => {
  it('returns interests linked to followed people\'s channels', () => {
    follow(KID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    const result = getInferredInterests(KID);
    expect(result.map((r) => r.interestId)).toEqual([MINECRAFT]);
    expect(result[0]).toMatchObject({ label: 'Minecraft', followerCount: 1, confidence: 1.0 });
  });

  it('returns an empty set for a user with no follows', () => {
    expect(getInferredInterests(KID)).toEqual([]);
  });

  it('excludes an inferred interest still pending search-terms (kid-safety ordering)', () => {
    // A Tier-2 inferred interest sits on the pending sentinel until its
    // search_terms are generated. Proposing it before then would let a Keep
    // enqueue the guard eval with no terms to judge (#52). It must stay hidden
    // until generation lands (a permanent failure stays hidden — fail-closed).
    db.prepare(
      "INSERT OR IGNORE INTO interests (id, label, category, source, search_terms) VALUES ('pending_topic','Pending Topic',NULL,'inferred',?)",
    ).run('__pending_specificity__');
    follow(KID, PERSON_A);
    link(CHANNEL_A, 'pending_topic', 1.0);

    expect(getInferredInterests(KID)).toEqual([]);
  });

  it('excludes interests the user has already declared (no duplicate provenance)', () => {
    follow(KID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);
    link(CHANNEL_A, PROGRAMMING, 1.0);
    declare(KID, MINECRAFT, 1);

    const result = getInferredInterests(KID);
    expect(result.map((r) => r.interestId)).toEqual([PROGRAMMING]);
  });

  it('excludes interests the user has Removed (suppressed)', () => {
    follow(KID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);
    link(CHANNEL_A, PROGRAMMING, 1.0);
    suppressInferredInterest(KID, MINECRAFT);

    const result = getInferredInterests(KID);
    expect(result.map((r) => r.interestId)).toEqual([PROGRAMMING]);
  });

  it('does not leak another user\'s follows', () => {
    follow(PARENT, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    expect(getInferredInterests(KID)).toEqual([]);
  });
});

describe('getInferredInterests — ordering by signal strength', () => {
  it('orders by distinct followed people first, then confidence', () => {
    // Minecraft: 2 distinct followed people (A, B). Programming: 1 person (C)
    // but higher confidence. Distinct-people wins, so Minecraft ranks first.
    follow(KID, PERSON_A);
    follow(KID, PERSON_B);
    follow(KID, PERSON_C);
    link(CHANNEL_A, MINECRAFT, 0.5);
    link(CHANNEL_B, MINECRAFT, 0.6);
    link(CHANNEL_C, PROGRAMMING, 1.0);

    const result = getInferredInterests(KID);
    expect(result.map((r) => r.interestId)).toEqual([MINECRAFT, PROGRAMMING]);
    expect(result[0]).toMatchObject({ followerCount: 2, confidence: 0.6 });
    expect(result[1]).toMatchObject({ followerCount: 1, confidence: 1.0 });
  });

  it('breaks a follower-count tie by max confidence', () => {
    follow(KID, PERSON_A);
    follow(KID, PERSON_B);
    link(CHANNEL_A, MINECRAFT, 0.4);
    link(CHANNEL_B, PROGRAMMING, 0.9);

    const result = getInferredInterests(KID);
    expect(result.map((r) => r.interestId)).toEqual([PROGRAMMING, MINECRAFT]);
  });
});

describe('suppressInferredInterest', () => {
  it('persists a Remove so re-deriving never resurfaces the interest', () => {
    follow(KID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    suppressInferredInterest(KID, MINECRAFT);
    expect(getInferredInterests(KID)).toEqual([]);

    // Re-derive (a second read) still excludes it.
    expect(getInferredInterests(KID)).toEqual([]);
  });

  it('does not unfollow — the follow row stands', () => {
    follow(KID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    suppressInferredInterest(KID, MINECRAFT);

    const follows = db.prepare(
      'SELECT person_id FROM followed_people WHERE user_id = ?'
    ).all(KID) as Array<{ person_id: string }>;
    expect(follows.map((r) => r.person_id)).toEqual([PERSON_A]);
  });

  it('is idempotent (a second Remove does not throw)', () => {
    suppressInferredInterest(KID, MINECRAFT);
    expect(() => suppressInferredInterest(KID, MINECRAFT)).not.toThrow();
  });
});

describe('keepInferredInterest', () => {
  it('inserts a declared user_interests row at the next rank', () => {
    declare(KID, PROGRAMMING, 1);

    const result = keepInferredInterest(KID, MINECRAFT);
    expect(result).toEqual({ interestId: MINECRAFT, rank: 2 });

    const rows = db.prepare(
      'SELECT interest_id, rank FROM user_interests WHERE user_id = ? ORDER BY rank'
    ).all(KID) as Array<{ interest_id: string; rank: number }>;
    expect(rows).toEqual([
      { interest_id: PROGRAMMING, rank: 1 },
      { interest_id: MINECRAFT, rank: 2 },
    ]);
  });

  it('keeps at rank 1 when the user has no declared interests yet', () => {
    const result = keepInferredInterest(KID, MINECRAFT);
    expect(result.rank).toBe(1);
  });

  it('a Keep by a kid enqueues the guard eval after the row exists', () => {
    keepInferredInterest(KID, MINECRAFT);

    // Row is declared before the eval is enqueued.
    const row = db.prepare(
      'SELECT 1 FROM user_interests WHERE user_id = ? AND interest_id = ?'
    ).get(KID, MINECRAFT);
    expect(row).toBeTruthy();

    expect(guardAdd).toHaveBeenCalledTimes(1);
    expect(guardAdd).toHaveBeenCalledWith(
      KID_INTEREST_EVAL_JOB,
      { userId: KID, interestId: MINECRAFT, rawLabel: 'Minecraft' },
    );
  });

  it('a Keep by a parent does NOT enqueue a guard eval', () => {
    keepInferredInterest(PARENT, MINECRAFT);

    expect(guardAdd).not.toHaveBeenCalled();
    const row = db.prepare(
      'SELECT 1 FROM user_interests WHERE user_id = ? AND interest_id = ?'
    ).get(PARENT, MINECRAFT);
    expect(row).toBeTruthy();
  });

  it('does not roll back the Keep when enqueueing the guard eval fails', async () => {
    guardAdd.mockRejectedValueOnce(new Error('redis down'));

    const result = keepInferredInterest(KID, MINECRAFT);
    expect(result.rank).toBe(1);

    // Let the rejected promise settle; the Keep must still stand.
    await Promise.resolve();

    const row = db.prepare(
      'SELECT 1 FROM user_interests WHERE user_id = ? AND interest_id = ?'
    ).get(KID, MINECRAFT);
    expect(row).toBeTruthy();
  });
});
