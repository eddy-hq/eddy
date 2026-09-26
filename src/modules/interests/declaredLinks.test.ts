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
import { getDeclaredInterestLinks, getDeclaredChannelInterest, getEngagedChannelsLackingInterestLinks } from './declaredLinks';

const KID = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';

const FOOTBALL = 'football';
const GAMING = 'gaming';

const PERSON_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PERSON_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL_A = 'UCaaa';
const CHANNEL_B = 'UCbbb';

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

let seq = 0;
function request(userId: string, channelId: string, opts: { watchedAt?: string; savedAt?: string; channel?: string } = {}): void {
  seq += 1;
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, youtube_channel_id, channel, status, requested_at, watched_at, saved_at)
    VALUES (?, ?, 'search', ?, ?, ?, ?, 'ready', ?, ?, ?)
  `).run(
    `req-${seq}`,
    userId,
    `https://youtu.be/vid-${seq}`,
    `vid-${seq}`,
    channelId,
    opts.channel ?? null,
    new Date().toISOString(),
    opts.watchedAt ?? null,
    opts.savedAt ?? null,
  );
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();

  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(KID, 'Boy1', 'kid', 12, now);
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(OTHER, 'Boy2', 'kid', 10, now);

  db.prepare('INSERT INTO interests (id, label, category) VALUES (?, ?, ?)').run(FOOTBALL, 'football', 'sport');
  db.prepare('INSERT INTO interests (id, label, category) VALUES (?, ?, ?)').run(GAMING, 'gaming', 'games');

  for (const [pid, cid, name] of [
    [PERSON_A, CHANNEL_A, 'Creator A'],
    [PERSON_B, CHANNEL_B, 'Creator B'],
  ] as const) {
    db.prepare('INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)')
      .run(pid, name, 'creator', now);
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
  db.exec('DELETE FROM requests');
});

describe('getDeclaredInterestLinks', () => {
  it('returns links to interests the user has declared', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);

    const result = getDeclaredInterestLinks(KID);
    expect(result).toEqual([
      { channelId: CHANNEL_A, interestId: FOOTBALL, label: 'football', category: 'sport' },
    ]);
  });

  it('excludes links to interests the user has NOT declared', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, GAMING, 1.0); // gaming not declared

    expect(getDeclaredInterestLinks(KID)).toEqual([]);
  });

  it('returns one row per matching channel+interest (multi-interest)', () => {
    declare(KID, FOOTBALL, 1);
    declare(KID, GAMING, 2);
    link(CHANNEL_A, FOOTBALL, 1.0);
    link(CHANNEL_A, GAMING, 1.0);

    const result = getDeclaredInterestLinks(KID);
    expect(result.map((r) => r.interestId).sort()).toEqual([FOOTBALL, GAMING].sort());
  });

  it('does not leak another user\'s declared interests', () => {
    declare(OTHER, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);

    expect(getDeclaredInterestLinks(KID)).toEqual([]);
  });
});

describe('getDeclaredChannelInterest', () => {
  it('returns the channel interest when the user has declared it', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);

    expect(getDeclaredChannelInterest(KID, CHANNEL_A)).toBe(FOOTBALL);
  });

  it('returns null when the user has NOT declared the inferred interest (no leak)', () => {
    // Channel globally inferred as gaming, but KID never declared gaming — the
    // global channel_interest_links inference must not stamp it onto the feed.
    link(CHANNEL_A, GAMING, 1.0);

    expect(getDeclaredChannelInterest(KID, CHANNEL_A)).toBeNull();
  });

  it('returns null for a user with no declared interests at all', () => {
    link(CHANNEL_A, FOOTBALL, 1.0);

    expect(getDeclaredChannelInterest(KID, CHANNEL_A)).toBeNull();
  });

  it('does not inherit another user\'s declared interest', () => {
    // OTHER declared football; KID did not. The same channel is followed by
    // both, but the link only traces to OTHER's declaration.
    declare(OTHER, FOOTBALL, 1);
    link(CHANNEL_A, FOOTBALL, 1.0);

    expect(getDeclaredChannelInterest(OTHER, CHANNEL_A)).toBe(FOOTBALL);
    expect(getDeclaredChannelInterest(KID, CHANNEL_A)).toBeNull();
  });

  it('picks the highest-confidence declared link when several match', () => {
    declare(KID, FOOTBALL, 1);
    declare(KID, GAMING, 2);
    link(CHANNEL_A, GAMING, 0.4);
    link(CHANNEL_A, FOOTBALL, 0.9);

    expect(getDeclaredChannelInterest(KID, CHANNEL_A)).toBe(FOOTBALL);
  });

  it('skips a higher-confidence UNdeclared link in favour of a declared one', () => {
    declare(KID, FOOTBALL, 1);
    link(CHANNEL_A, GAMING, 1.0);    // higher confidence, NOT declared
    link(CHANNEL_A, FOOTBALL, 0.3);  // lower confidence, declared

    expect(getDeclaredChannelInterest(KID, CHANNEL_A)).toBe(FOOTBALL);
  });
});

describe('getEngagedChannelsLackingInterestLinks', () => {
  it('returns an engaged channel that has no links, naming it from requests.channel', () => {
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z', channel: 'Creator A' });

    const result = getEngagedChannelsLackingInterestLinks();
    expect(result).toEqual([{ channelId: CHANNEL_A, channelName: 'Creator A' }]);
  });

  it('falls back to the linked person display_name when requests.channel is null', () => {
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    const result = getEngagedChannelsLackingInterestLinks();
    expect(result).toEqual([{ channelId: CHANNEL_A, channelName: 'Creator A' }]);
  });

  it('excludes channels that already have a link row', () => {
    link(CHANNEL_A, FOOTBALL, 1.0);
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });

    expect(getEngagedChannelsLackingInterestLinks()).toEqual([]);
  });

  it('excludes channels with no watched-or-saved engagement', () => {
    // A request that is neither watched nor saved does not qualify.
    request(KID, CHANNEL_A, {});

    expect(getEngagedChannelsLackingInterestLinks()).toEqual([]);
  });

  it('excludes a channel every engaging user already follows', () => {
    // Only KID engaged, and KID follows the channel's person → cannot surface
    // as a suggestion, so it must not be enqueued for inference.
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });
    follow(KID, PERSON_A);

    expect(getEngagedChannelsLackingInterestLinks()).toEqual([]);
  });

  it('ignores a parent pick (#217): the parent chose it, the kid did not engage with the channel', () => {
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });
    db.exec("UPDATE requests SET source = 'parent_pick'");

    expect(getEngagedChannelsLackingInterestLinks()).toEqual([]);
  });

  it('keeps a channel when at least one engaging user does not follow it', () => {
    // KID follows the channel; OTHER engaged but does not follow → keep.
    request(KID, CHANNEL_A, { watchedAt: '2026-05-01T00:00:00.000Z' });
    request(OTHER, CHANNEL_A, { savedAt: '2026-05-02T00:00:00.000Z' });
    follow(KID, PERSON_A);

    const result = getEngagedChannelsLackingInterestLinks();
    expect(result.map((r) => r.channelId)).toEqual([CHANNEL_A]);
  });
});
