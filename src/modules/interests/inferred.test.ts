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
import {
  getInferredInterests,
  suppressInferredInterest,
  keepInferredInterest,
} from './inferred';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_USER = '22222222-2222-7222-8222-222222222222';

// Interests in the shared vocabulary.
const MINECRAFT = 'minecraft';
const PROGRAMMING = 'programming';
const ELECTRONICS = 'electronics';
const ASTRONOMY = 'astronomy';

// People the user follows and their YouTube channel ids.
const PERSON_A = 'person-a';
const PERSON_B = 'person-b';
const PERSON_C = 'person-c';
const CHANNEL_A = 'UCchannelA';
const CHANNEL_B = 'UCchannelB';
const CHANNEL_C = 'UCchannelC';

function follow(userId: string, personId: string): void {
  db.prepare(
    'INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via) VALUES (?, ?, 1.0, ?, ?)'
  ).run(userId, personId, new Date().toISOString(), 'manual');
}

function link(channelId: string, interestId: string, confidence: number): void {
  db.prepare(
    'INSERT INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at) VALUES (?, ?, ?, ?)'
  ).run(channelId, interestId, confidence, new Date().toISOString());
}

function declare(userId: string, interestId: string, rank: number): void {
  db.prepare(
    'INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(userId, interestId, rank, 'comfortable', new Date().toISOString());
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(USER_ID, 'Boy1', 'kid', 12, now);
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(OTHER_USER, 'Boy2', 'kid', 10, now);

  for (const [id, label, category] of [
    [MINECRAFT, 'Minecraft', 'gaming'],
    [PROGRAMMING, 'Programming', 'tech'],
    [ELECTRONICS, 'Electronics', 'tech'],
    [ASTRONOMY, 'Astronomy', 'science'],
  ] as const) {
    db.prepare('INSERT INTO interests (id, label, category) VALUES (?, ?, ?)').run(id, label, category);
  }

  // People with one YouTube output (channel) each.
  for (const [personId, channelId] of [
    [PERSON_A, CHANNEL_A],
    [PERSON_B, CHANNEL_B],
    [PERSON_C, CHANNEL_C],
  ] as const) {
    db.prepare(
      'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)'
    ).run(personId, personId, 'creator', now);
    db.prepare(
      'INSERT INTO person_outputs (output_id, person_id, output_type, external_id, active) VALUES (?, ?, ?, ?, 1)'
    ).run(`out-${personId}`, personId, 'youtube', channelId);
  }
});

beforeEach(() => {
  db.exec('DELETE FROM followed_people');
  db.exec('DELETE FROM channel_interest_links');
  db.exec('DELETE FROM user_interests');
  db.exec('DELETE FROM inferred_interest_suppressions');
});

describe('getInferredInterests', () => {
  it('returns interests linked to followed people\'s channels', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    const result = getInferredInterests(USER_ID);
    expect(result.map((r) => r.interestId)).toEqual([MINECRAFT]);
    expect(result[0]).toMatchObject({ label: 'Minecraft', category: 'gaming', followerCount: 1 });
  });

  it('excludes interests the user has already declared', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);
    link(CHANNEL_A, PROGRAMMING, 1.0);
    declare(USER_ID, MINECRAFT, 1);

    const result = getInferredInterests(USER_ID);
    expect(result.map((r) => r.interestId)).toEqual([PROGRAMMING]);
  });

  it('excludes interests the user has Removed (suppressed)', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);
    link(CHANNEL_A, PROGRAMMING, 1.0);

    suppressInferredInterest(USER_ID, MINECRAFT);

    const result = getInferredInterests(USER_ID);
    expect(result.map((r) => r.interestId)).toEqual([PROGRAMMING]);
  });

  it('orders by distinct followed people first, then confidence', () => {
    // Programming is linked by two distinct followed people; astronomy by one
    // at high confidence; electronics by one at lower confidence. Distinct-
    // people wins over confidence, so programming leads despite a tie on
    // per-link confidence with electronics.
    follow(USER_ID, PERSON_A);
    follow(USER_ID, PERSON_B);
    follow(USER_ID, PERSON_C);

    link(CHANNEL_A, PROGRAMMING, 0.5);
    link(CHANNEL_B, PROGRAMMING, 0.5);
    link(CHANNEL_B, ASTRONOMY, 0.9);
    link(CHANNEL_C, ELECTRONICS, 0.5);

    const result = getInferredInterests(USER_ID);
    expect(result.map((r) => r.interestId)).toEqual([PROGRAMMING, ASTRONOMY, ELECTRONICS]);
    expect(result[0]).toMatchObject({ interestId: PROGRAMMING, followerCount: 2, confidence: 0.5 });
    expect(result[1]).toMatchObject({ interestId: ASTRONOMY, followerCount: 1, confidence: 0.9 });
  });

  it('does not resurface a suppressed interest on re-derive', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    expect(getInferredInterests(USER_ID).map((r) => r.interestId)).toEqual([MINECRAFT]);
    suppressInferredInterest(USER_ID, MINECRAFT);
    expect(getInferredInterests(USER_ID)).toEqual([]);
  });

  it('does not surface another user\'s follows', () => {
    follow(OTHER_USER, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    expect(getInferredInterests(USER_ID)).toEqual([]);
  });

  it('ignores inactive person outputs', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);
    db.prepare('UPDATE person_outputs SET active = 0 WHERE person_id = ?').run(PERSON_A);

    expect(getInferredInterests(USER_ID)).toEqual([]);

    // Restore for subsequent tests (people/outputs survive beforeEach).
    db.prepare('UPDATE person_outputs SET active = 1 WHERE person_id = ?').run(PERSON_A);
  });
});

describe('suppressInferredInterest', () => {
  it('does not unfollow the person', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    suppressInferredInterest(USER_ID, MINECRAFT);

    const stillFollowing = db.prepare(
      'SELECT 1 FROM followed_people WHERE user_id = ? AND person_id = ?'
    ).get(USER_ID, PERSON_A);
    expect(stillFollowing).toBeTruthy();
  });

  it('is idempotent', () => {
    suppressInferredInterest(USER_ID, MINECRAFT);
    expect(() => suppressInferredInterest(USER_ID, MINECRAFT)).not.toThrow();
    const count = db.prepare(
      'SELECT COUNT(*) AS c FROM inferred_interest_suppressions WHERE user_id = ? AND interest_id = ?'
    ).get(USER_ID, MINECRAFT) as { c: number };
    expect(count.c).toBe(1);
  });
});

describe('keepInferredInterest', () => {
  it('inserts a declared user_interests row at the next rank', () => {
    declare(USER_ID, ELECTRONICS, 1);
    declare(USER_ID, ASTRONOMY, 2);

    keepInferredInterest(USER_ID, MINECRAFT);

    const row = db.prepare(
      'SELECT interest_id, rank, expertise, liked FROM user_interests WHERE user_id = ? AND interest_id = ?'
    ).get(USER_ID, MINECRAFT) as { interest_id: string; rank: number; expertise: string; liked: number };
    expect(row).toMatchObject({ interest_id: MINECRAFT, rank: 3, expertise: 'comfortable', liked: 1 });
  });

  it('inserts at rank 1 when the user has no declared interests', () => {
    keepInferredInterest(USER_ID, MINECRAFT);

    const row = db.prepare(
      'SELECT rank FROM user_interests WHERE user_id = ? AND interest_id = ?'
    ).get(USER_ID, MINECRAFT) as { rank: number };
    expect(row.rank).toBe(1);
  });

  it('clears a prior suppression so a Keep after a Remove sticks', () => {
    suppressInferredInterest(USER_ID, MINECRAFT);
    keepInferredInterest(USER_ID, MINECRAFT);

    const suppression = db.prepare(
      'SELECT 1 FROM inferred_interest_suppressions WHERE user_id = ? AND interest_id = ?'
    ).get(USER_ID, MINECRAFT);
    expect(suppression).toBeUndefined();

    const declared = db.prepare(
      'SELECT 1 FROM user_interests WHERE user_id = ? AND interest_id = ?'
    ).get(USER_ID, MINECRAFT);
    expect(declared).toBeTruthy();
  });

  it('once kept, the interest no longer derives as inferred', () => {
    follow(USER_ID, PERSON_A);
    link(CHANNEL_A, MINECRAFT, 1.0);

    expect(getInferredInterests(USER_ID).map((r) => r.interestId)).toEqual([MINECRAFT]);
    keepInferredInterest(USER_ID, MINECRAFT);
    expect(getInferredInterests(USER_ID)).toEqual([]);
  });
});
