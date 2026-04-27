import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { NotFoundError } from '../../errors';
import { getPersonView, parseSupportUrls } from './personView';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const PERSON_ID = '22222222-2222-7222-8222-222222222222';
const CHANNEL_ID = 'UCabc123';
const CHANNEL_NAME = 'Bricks & Bots';

function insertRequest(opts: {
  request_id: string;
  status: string;
  channel?: string | null;
  added_at?: string;
  watched_at?: string | null;
  user_id?: string;
  file_state?: string;
}): void {
  const now = opts.added_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO requests
       (request_id, user_id, source, url, youtube_id, title, channel, status, file_state,
        requested_at, added_at, watched_at)
     VALUES (?, ?, 'channel_subscription', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.request_id,
    opts.user_id ?? USER_ID,
    `https://www.youtube.com/watch?v=${opts.request_id}`,
    `yt-${opts.request_id}`,
    `Title ${opts.request_id}`,
    opts.channel === undefined ? CHANNEL_NAME : opts.channel,
    opts.status,
    opts.file_state ?? 'live',
    now,
    now,
    opts.watched_at ?? null,
  );
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 0, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM followed_people');
  db.exec('DELETE FROM person_outputs');
  db.exec('DELETE FROM people');
});

function seedPerson(opts: {
  bio?: string | null;
  photoUrl?: string | null;
  supportUrls?: string | null;
} = {}): void {
  db.prepare(`
    INSERT INTO people (person_id, display_name, person_type, photo_url, bio, support_urls, created_at)
    VALUES (?, ?, 'individual', ?, ?, ?, ?)
  `).run(
    PERSON_ID,
    CHANNEL_NAME,
    opts.photoUrl ?? null,
    opts.bio ?? null,
    opts.supportUrls ?? null,
    new Date().toISOString(),
  );

  db.prepare(`
    INSERT INTO person_outputs (output_id, person_id, output_type, fetcher_type, feed_url, external_id, active)
    VALUES (?, ?, 'youtube', 'youtube-rss', ?, ?, 1)
  `).run(
    'output-1',
    PERSON_ID,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    CHANNEL_ID,
  );
}

function seedFollow(followedAt = '2026-02-15T10:00:00.000Z'): void {
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, 1.0, ?, 'manual')
  `).run(USER_ID, PERSON_ID, followedAt);
}

describe('getPersonView', () => {
  it('throws NotFoundError when the person does not exist', () => {
    expect(() => getPersonView('does-not-exist', USER_ID)).toThrow(NotFoundError);
  });

  it('returns person row + channelId + followedAt for a followed person with no items', () => {
    seedPerson({ bio: 'A channel about Lego builds.', photoUrl: 'http://avatar' });
    seedFollow('2026-03-01T09:00:00.000Z');

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.person).toEqual({
      personId: PERSON_ID,
      displayName: CHANNEL_NAME,
      personType: 'individual',
      photoUrl: 'http://avatar',
      bio: 'A channel about Lego builds.',
      channelId: CHANNEL_ID,
    });
    expect(view.followedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(view.items).toEqual([]);
    expect(view.support).toEqual([]);
  });

  it('returns null followedAt when the user does not follow this person', () => {
    seedPerson();

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.followedAt).toBeNull();
  });

  it('returns up to 6 most-recent in-library items for this person, reverse-chronological', () => {
    seedPerson();
    seedFollow();
    // Insert 8 in-library items, ascending by added_at, all from this channel
    for (let i = 0; i < 8; i++) {
      const t = `2026-04-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`;
      insertRequest({ request_id: `r${i}`, status: 'ready', added_at: t });
    }

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.items).toHaveLength(6);
    // Most-recent first
    expect(view.items[0].request_id).toBe('r7');
    expect(view.items[5].request_id).toBe('r2');
  });

  it('includes watched items with watched_at populated', () => {
    seedPerson();
    seedFollow();
    insertRequest({
      request_id: 'r-watched',
      status: 'watched',
      added_at: '2026-04-10T10:00:00.000Z',
      watched_at: '2026-04-10T10:30:00.000Z',
    });

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.items).toHaveLength(1);
    expect(view.items[0].watched_at).toBe('2026-04-10T10:30:00.000Z');
    expect(view.items[0].status).toBe('watched');
  });

  it('excludes items still in the request pipeline (downloading, parent_review, rejected)', () => {
    seedPerson();
    seedFollow();
    insertRequest({ request_id: 'r-dl',  status: 'downloading' });
    insertRequest({ request_id: 'r-pr',  status: 'parent_review' });
    insertRequest({ request_id: 'r-rej', status: 'rejected' });
    insertRequest({ request_id: 'r-ok',  status: 'ready' });

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.items.map((i) => i.request_id)).toEqual(['r-ok']);
  });

  it('excludes items belonging to a different user', () => {
    seedPerson();
    seedFollow();
    const OTHER_USER = '33333333-3333-7333-8333-333333333333';
    db.prepare(
      'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(OTHER_USER, 'Boy2', 'kid', 0, new Date().toISOString());
    insertRequest({ request_id: 'r-mine',   status: 'ready' });
    insertRequest({ request_id: 'r-others', status: 'ready', user_id: OTHER_USER });

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.items.map((i) => i.request_id)).toEqual(['r-mine']);
  });

  it('excludes items from a different channel name', () => {
    seedPerson();
    seedFollow();
    insertRequest({ request_id: 'r-mine',  status: 'ready' });
    insertRequest({ request_id: 'r-other', status: 'ready', channel: 'Some Other Channel' });

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.items.map((i) => i.request_id)).toEqual(['r-mine']);
  });

  it('returns parsed support sources from JSON support_urls', () => {
    seedPerson({
      supportUrls: JSON.stringify([
        'https://www.patreon.com/example',
        'https://example.substack.com',
        'https://example.bandcamp.com',
        'https://ko-fi.com/example',
        'https://bookshop.org/shop/example',
        { kind: 'merch', url: 'https://shop.example.com' },
        'https://random.example.com',
      ]),
    });
    seedFollow();

    const view = getPersonView(PERSON_ID, USER_ID);

    expect(view.support.map((s) => ({ kind: s.kind, url: s.url }))).toEqual([
      { kind: 'patreon',  url: 'https://www.patreon.com/example' },
      { kind: 'substack', url: 'https://example.substack.com' },
      { kind: 'bandcamp', url: 'https://example.bandcamp.com' },
      { kind: 'kofi',     url: 'https://ko-fi.com/example' },
      { kind: 'bookshop', url: 'https://bookshop.org/shop/example' },
      { kind: 'merch',    url: 'https://shop.example.com' },
      { kind: 'other',    url: 'https://random.example.com' },
    ]);
  });
});

describe('parseSupportUrls', () => {
  it('returns [] for null/empty/garbage', () => {
    expect(parseSupportUrls(null)).toEqual([]);
    expect(parseSupportUrls('')).toEqual([]);
    expect(parseSupportUrls('not-json')).toEqual([]);
    expect(parseSupportUrls('{}')).toEqual([]);
  });

  it('drops non-http entries', () => {
    expect(parseSupportUrls(JSON.stringify(['javascript:alert(1)', 'mailto:x@y']))).toEqual([]);
  });

  it('dedupes repeated URLs', () => {
    const out = parseSupportUrls(JSON.stringify([
      'https://www.patreon.com/x',
      'https://www.patreon.com/x',
    ]));
    expect(out).toHaveLength(1);
  });
});
