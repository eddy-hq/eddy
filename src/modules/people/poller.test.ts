import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// `:memory:` SQLite is the test fixture. The poller now writes directly to
// `candidate_pool` (ADR-0009) — no requests state machine, no BullMQ — so the
// only real ports are `videoDuration`, `applyChannelInfoToPerson`, and
// `fetch`, all mocked at module level. Assertions hit on-disk DB rows.
vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../config', () => ({
  config: { YTDLP_BIN_M4: '/fake/yt-dlp', NODE_ENV: 'test', REDIS_URL: 'redis://fake' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The poller imports the batched `videoDurations` from the discovery-metadata
// seam, which (config has no DISCOVERY_SOURCE → not 'api') dispatches to the
// real `ytdlp.videoDurations`. We mock the whole ytdlp module, so the seam
// reaches these fakes. `videoDurations` is given a loop-over-`videoDuration`
// implementation in beforeEach so the existing per-id mocks keep driving it;
// the quota test overrides it to reject at the batch level.
vi.mock('../../ytdlp', () => ({
  videoDuration: vi.fn(),
  videoDurations: vi.fn(),
}));

vi.mock('./registry', () => ({
  ensurePersonForChannel: vi.fn(),
  applyChannelInfoToPerson: vi.fn(),
}));

import { db } from '../../db/client';
import { logger } from '../../logger';
import { runMigrations } from '../../db/migrate';
import { videoDuration, videoDurations } from '../../ytdlp';
import { applyChannelInfoToPerson } from './registry';
import { pollChannel, parseYoutubeRss, type OutputRow } from './poller';

// `parseYoutubeRss` is exported (purely so tests can pin its three observable
// properties) and is also exercised indirectly through `pollChannel`, which is
// the actual production call site.

const USER_ID_A = '11111111-1111-7111-8111-111111111111';
const USER_ID_B = '22222222-2222-7222-8222-222222222222';
const PERSON_ID = 'person-poller-1';
const CHANNEL_ID = 'UCpollerchannel1xxxxxxx';
const OUTPUT_ID = 'output-poller-1';
const CHANNEL_NAME = 'Followed Creator';

const OUTPUT: OutputRow = {
  output_id: OUTPUT_ID,
  channel_id: CHANNEL_ID,
  person_id: PERSON_ID,
  channel_name: CHANNEL_NAME,
};

function rssXml(opts: {
  channelName?: string;
  entries: Array<{
    videoId: string;
    title: string;
    publishedAt?: string;
    thumbnailUrl?: string | null;
  }>;
}): string {
  const channelName = opts.channelName ?? CHANNEL_NAME;
  const entries = opts.entries
    .map((e) => {
      const thumb =
        e.thumbnailUrl === null
          ? ''
          : `<media:thumbnail url="${e.thumbnailUrl ?? `https://i.ytimg.com/vi/${e.videoId}/hq.jpg`}"/>`;
      const published = e.publishedAt ?? '2026-05-01T00:00:00+00:00';
      return `<entry>
  <yt:videoId>${e.videoId}</yt:videoId>
  <title>${e.title}</title>
  <published>${published}</published>
  ${thumb}
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>${channelName}</title>
  ${entries}
</feed>`;
}

function mockFetchOk(xml: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(xml),
  }));
}

function mockFetchNon200(status: number): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(''),
  }));
}

function mockFetchThrow(err: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
}

function insertPerson(): void {
  db.prepare(
    `INSERT OR REPLACE INTO people (person_id, display_name, created_at)
     VALUES (?, ?, ?)`,
  ).run(PERSON_ID, CHANNEL_NAME, new Date().toISOString());
}

function insertPersonOutput(): void {
  db.prepare(
    `INSERT OR REPLACE INTO person_outputs
       (output_id, person_id, output_type, external_id, active, last_polled)
     VALUES (?, ?, 'youtube', ?, 1, NULL)`,
  ).run(OUTPUT_ID, PERSON_ID, CHANNEL_ID);
}

function insertFollower(userId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO followed_people
       (user_id, person_id, trust_weight, followed_at, followed_via)
     VALUES (?, ?, 1.0, ?, 'manual')`,
  ).run(userId, PERSON_ID, new Date().toISOString());
}

function insertUser(userId: string, name: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO users (user_id, display_name, role, age_gate, created_at)
     VALUES (?, ?, 'kid', 12, ?)`,
  ).run(userId, name, new Date().toISOString());
}

function insertSeenVideo(videoId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO seen_videos (channel_id, video_id, seen_at)
     VALUES (?, ?, ?)`,
  ).run(CHANNEL_ID, videoId, new Date().toISOString());
}

// Subscription candidates for the channel's followers, by user.
function subscriptionCandidates(userId: string): Array<{ external_id: string; source_type: string }> {
  return db
    .prepare(
      "SELECT external_id, source_type FROM candidate_pool WHERE user_id = ? AND source_type = 'subscription'",
    )
    .all(userId) as Array<{ external_id: string; source_type: string }>;
}

beforeAll(() => {
  runMigrations();
  insertUser(USER_ID_A, 'Boy1');
  insertUser(USER_ID_B, 'Boy2');
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM seen_videos');
  db.exec('DELETE FROM followed_people');
  db.exec('DELETE FROM person_outputs');
  db.exec('DELETE FROM people');
  db.exec('DELETE FROM channel_interest_links');

  insertPerson();
  insertPersonOutput();

  vi.mocked(videoDuration).mockReset();
  // Mirror the real ytdlp.videoDurations: loop the per-id probe, dropping ids
  // whose probe throws. Lets every test keep driving behaviour through the
  // existing `videoDuration` mock; the quota test overrides this directly.
  vi.mocked(videoDurations).mockReset();
  vi.mocked(videoDurations).mockImplementation(async (ids: string[]) => {
    const out = new Map<string, number>();
    for (const id of ids) {
      try {
        out.set(id, await vi.mocked(videoDuration)(id));
      } catch {
        /* unusable / flake → unknown, omit */
      }
    }
    return out;
  });
  vi.mocked(applyChannelInfoToPerson).mockReset();
  vi.mocked(applyChannelInfoToPerson).mockResolvedValue(undefined);
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.debug).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.unstubAllGlobals();
});

// ─── parseYoutubeRss (direct, pure) ─────────────────────────────────────────

describe('parseYoutubeRss', () => {
  it('decodes HTML entities in <title> (&amp;, &lt;, &gt;, &quot;, &#39;, &#x27;)', () => {
    const xml = rssXml({
      entries: [
        {
          videoId: 'entityvid01',
          title: 'A &amp; B &lt;script&gt; said &quot;hi&quot; — it&#39;s &#x27;mine&#x27;',
        },
      ],
    });

    const { videos } = parseYoutubeRss(xml);

    expect(videos).toHaveLength(1);
    expect(videos[0]?.title).toBe(`A & B <script> said "hi" — it's 'mine'`);
  });

  it('returns thumbnailUrl: null when <media:thumbnail> is absent (and does not crash)', () => {
    const xml = rssXml({
      entries: [
        { videoId: 'nothumbvid1', title: 'No thumbnail entry', thumbnailUrl: null },
      ],
    });

    const { videos } = parseYoutubeRss(xml);

    expect(videos).toHaveLength(1);
    expect(videos[0]?.thumbnailUrl).toBeNull();
  });

  it('captures <media:thumbnail url="..."> when present', () => {
    const xml = rssXml({
      entries: [
        {
          videoId: 'withthumb01',
          title: 'Has a thumbnail',
          thumbnailUrl: 'https://i.ytimg.com/vi/withthumb01/hq.jpg',
        },
      ],
    });

    const { videos } = parseYoutubeRss(xml);

    expect(videos[0]?.thumbnailUrl).toBe('https://i.ytimg.com/vi/withthumb01/hq.jpg');
  });

  it('yields multi-entry feeds in document order', () => {
    const xml = rssXml({
      entries: [
        { videoId: 'first111111', title: 'First' },
        { videoId: 'second22222', title: 'Second' },
        { videoId: 'third333333', title: 'Third' },
      ],
    });

    const { videos } = parseYoutubeRss(xml);

    expect(videos.map((v) => v.videoId)).toEqual(['first111111', 'second22222', 'third333333']);
    expect(videos.map((v) => v.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('parses channel-level title (decoded) from the feed', () => {
    const xml = rssXml({
      channelName: 'Lego &amp; Friends',
      entries: [{ videoId: 'cnamevid001', title: 't' }],
    });

    const { channelName } = parseYoutubeRss(xml);

    expect(channelName).toBe('Lego & Friends');
  });
});

// ─── pollChannel: first-poll confirmation ───────────────────────────────────

describe('pollChannel first-poll confirmation', () => {
  it('with empty seen_videos + 5 entries (latest non-short) → 1 subscription candidate, 5 seen_videos rows', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        { videoId: 'aaa11111111', title: 'Latest' },
        { videoId: 'bbb22222222', title: 'Second' },
        { videoId: 'ccc33333333', title: 'Third' },
        { videoId: 'ddd44444444', title: 'Fourth' },
        { videoId: 'eee55555555', title: 'Fifth' },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const candidates = subscriptionCandidates(USER_ID_A);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.external_id).toBe('aaa11111111');

    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ?')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen).toHaveLength(5);
  });

  it('latest entry is a short → skipped before the confirmation slot is consumed; next non-short becomes the candidate', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        { videoId: 'shortvid001', title: 'A short' },
        { videoId: 'longvid0001', title: 'A real video' },
        { videoId: 'longvid0002', title: 'Older video' },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockImplementation(async (id: string) => {
      if (id === 'shortvid001') return 30;
      return 600;
    });

    await pollChannel(OUTPUT);

    const candidates = subscriptionCandidates(USER_ID_A);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.external_id).toBe('longvid0001');

    // All three videos are marked seen — the short to suppress re-evaluation,
    // the candidate one as the confirmation, and the older one as part of the
    // first-poll catch-up.
    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ?')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen.map((s) => s.video_id).sort()).toEqual(
      ['longvid0001', 'longvid0002', 'shortvid001'].sort(),
    );
  });

  it('videoDuration throwing → entry is not classified as a short and becomes a candidate (better to keep a creator than drop them)', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [{ videoId: 'flakyvid001', title: 'Flaky metadata' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockRejectedValue(new Error('yt-dlp 429'));

    await pollChannel(OUTPUT);

    const candidates = subscriptionCandidates(USER_ID_A);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.external_id).toBe('flakyvid001');
  });

  it('the seeded candidate carries person_id, channel, thumbnail and published_at for scoring', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        {
          videoId: 'fullmeta001',
          title: 'Rich metadata upload',
          publishedAt: '2026-05-02T10:00:00+00:00',
          thumbnailUrl: 'https://i.ytimg.com/vi/fullmeta001/hq.jpg',
        },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(720);

    await pollChannel(OUTPUT);

    const row = db
      .prepare(
        `SELECT person_id, channel, duration_secs, thumbnail_url, published_at, title, status
         FROM candidate_pool WHERE user_id = ? AND external_id = ?`,
      )
      .get(USER_ID_A, 'fullmeta001') as {
        person_id: string | null; channel: string | null; duration_secs: number | null;
        thumbnail_url: string | null; published_at: string | null; title: string | null; status: string;
      };
    expect(row.person_id).toBe(PERSON_ID);
    expect(row.channel).toBe(CHANNEL_NAME);
    expect(row.duration_secs).toBe(720);
    expect(row.thumbnail_url).toBe('https://i.ytimg.com/vi/fullmeta001/hq.jpg');
    expect(row.published_at).toBe('2026-05-02T10:00:00+00:00');
    expect(row.title).toBe('Rich metadata upload');
    expect(row.status).toBe('pending');
  });

  it('carries the channel interest_id when the follower has declared that interest', async () => {
    insertFollower(USER_ID_A);
    // Seed an interest + a channel→interest link so the candidate inherits it.
    db.prepare(
      "INSERT INTO interests (id, label, search_terms, category, source) VALUES (?, ?, '[]', 'tech', 'seed')",
    ).run('interest-x', 'robotics');
    db.prepare(
      `INSERT INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at)
       VALUES (?, ?, 0.9, ?)`,
    ).run(CHANNEL_ID, 'interest-x', new Date().toISOString());
    // The follower must have declared the interest: channel_interest_links is a
    // global, all-users inference, so the tag only carries when it traces to
    // THIS user's declaration (else it leaks another user's interest).
    db.prepare(
      "INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at) VALUES (?, ?, 1, 'comfortable', 1, ?)",
    ).run(USER_ID_A, 'interest-x', new Date().toISOString());

    const xml = rssXml({ entries: [{ videoId: 'linkedvid01', title: 'Linked' }] });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const row = db
      .prepare('SELECT interest_id FROM candidate_pool WHERE external_id = ?')
      .get('linkedvid01') as { interest_id: string | null };
    expect(row.interest_id).toBe('interest-x');
  });

  it('leaves interest_id null when the follower has NOT declared the channel interest', async () => {
    insertFollower(USER_ID_A);
    // Channel is globally inferred as interest-undeclared, which no user has
    // declared — the candidate must not inherit it (no leak).
    db.prepare(
      "INSERT OR IGNORE INTO interests (id, label, search_terms, category, source) VALUES (?, ?, '[]', 'tech', 'seed')",
    ).run('interest-undeclared', 'astronomy');
    db.prepare(
      `INSERT INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at)
       VALUES (?, ?, 0.9, ?)`,
    ).run(CHANNEL_ID, 'interest-undeclared', new Date().toISOString());

    const xml = rssXml({ entries: [{ videoId: 'linkedvid02', title: 'Linked' }] });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const row = db
      .prepare('SELECT interest_id FROM candidate_pool WHERE external_id = ?')
      .get('linkedvid02') as { interest_id: string | null };
    expect(row.interest_id).toBeNull();
  });
});

// ─── pollChannel: steady state ──────────────────────────────────────────────

describe('pollChannel steady state', () => {
  it('1 new entry against existing seen_videos → 1 subscription candidate per follower, both marked seen', async () => {
    insertFollower(USER_ID_A);
    insertFollower(USER_ID_B);
    // Seed prior seen entries so the channel is past first-poll.
    insertSeenVideo('priorvid001');
    insertSeenVideo('priorvid002');

    const xml = rssXml({
      entries: [
        { videoId: 'brandnew001', title: 'Brand new upload' },
        { videoId: 'priorvid001', title: 'Already seen' },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const candidates = db
      .prepare("SELECT user_id, external_id FROM candidate_pool WHERE source_type = 'subscription' ORDER BY user_id")
      .all() as Array<{ user_id: string; external_id: string }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((r) => r.user_id).sort()).toEqual([USER_ID_A, USER_ID_B].sort());
    expect(candidates.every((r) => r.external_id === 'brandnew001')).toBe(true);

    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ?')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen.map((s) => s.video_id).sort()).toEqual(
      ['brandnew001', 'priorvid001', 'priorvid002'].sort(),
    );
  });

  it('per-user dedup: a follower who already has a candidate for the same video does not get a second one', async () => {
    insertFollower(USER_ID_A);
    insertFollower(USER_ID_B);
    insertSeenVideo('priorvid001');

    // USER_ID_A already has a candidate (e.g. back-catalogue) for the new video.
    db.prepare(`
      INSERT INTO candidate_pool
        (candidate_id, user_id, content_type, source_type, url, external_id, status, created_at)
      VALUES (?, ?, 'video', 'person_backcatalog', ?, ?, 'pending', ?)
    `).run(
      'cand-existing-a', USER_ID_A,
      'https://www.youtube.com/watch?v=dupvid00001', 'dupvid00001',
      new Date().toISOString(),
    );

    const xml = rssXml({
      entries: [{ videoId: 'dupvid00001', title: 'Already a candidate for A' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const rows = db
      .prepare('SELECT user_id, source_type FROM candidate_pool WHERE external_id = ? ORDER BY user_id')
      .all('dupvid00001') as Array<{ user_id: string; source_type: string }>;
    expect(rows).toHaveLength(2);
    // A keeps its single back-catalogue row; B gets the new subscription row.
    expect(rows.map((r) => r.user_id).sort()).toEqual([USER_ID_A, USER_ID_B].sort());
    const a = rows.find((r) => r.user_id === USER_ID_A);
    const b = rows.find((r) => r.user_id === USER_ID_B);
    expect(a?.source_type).toBe('person_backcatalog');
    expect(b?.source_type).toBe('subscription');
  });

  it('per-user dedup against requests: a follower with an existing request does not get a candidate', async () => {
    insertFollower(USER_ID_A);
    insertSeenVideo('priorvid001');
    db.prepare(`
      INSERT INTO requests
        (request_id, user_id, source, url, youtube_id, status, requested_at)
      VALUES (?, ?, 'share_sheet', ?, ?, 'ready', ?)
    `).run(
      'req-existing-a', USER_ID_A,
      'https://www.youtube.com/watch?v=reqdup00001', 'reqdup00001',
      new Date().toISOString(),
    );

    const xml = rssXml({ entries: [{ videoId: 'reqdup00001', title: 'Already requested by A' }] });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const candidates = subscriptionCandidates(USER_ID_A);
    expect(candidates).toHaveLength(0);
  });

  it('no followers → early return; no seen_videos writes, no candidate writes, last_polled untouched', async () => {
    const xml = rssXml({
      entries: [{ videoId: 'orphanvid01', title: 'No-one is following' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM candidate_pool').get() as { c: number },
    ).toEqual({ c: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM seen_videos').get() as { c: number },
    ).toEqual({ c: 0 });
    const out = db
      .prepare('SELECT last_polled FROM person_outputs WHERE output_id = ?')
      .get(OUTPUT_ID) as { last_polled: string | null };
    expect(out.last_polled).toBeNull();
  });

  it('last_polled is updated only after a successful pass', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [{ videoId: 'pollvid0001', title: 'Pollable' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    const before = Date.now();
    await pollChannel(OUTPUT);

    const out = db
      .prepare('SELECT last_polled FROM person_outputs WHERE output_id = ?')
      .get(OUTPUT_ID) as { last_polled: string };
    expect(out.last_polled).not.toBeNull();
    expect(new Date(out.last_polled).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ─── pollChannel: failure modes ─────────────────────────────────────────────

describe('pollChannel failure modes', () => {
  it('RSS fetch non-200 → warn-log + early return, no DB writes', async () => {
    insertFollower(USER_ID_A);
    mockFetchNon200(503);

    await pollChannel(OUTPUT);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM candidate_pool').get() as { c: number },
    ).toEqual({ c: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM seen_videos').get() as { c: number },
    ).toEqual({ c: 0 });
    const out = db
      .prepare('SELECT last_polled FROM person_outputs WHERE output_id = ?')
      .get(OUTPUT_ID) as { last_polled: string | null };
    expect(out.last_polled).toBeNull();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ channelId: CHANNEL_ID, status: 503 });
  });

  it('RSS fetch throws (timeout / network) → warn-log + early return, no DB writes', async () => {
    insertFollower(USER_ID_A);
    mockFetchThrow(new Error('AbortError: signal timed out'));

    await pollChannel(OUTPUT);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM candidate_pool').get() as { c: number },
    ).toEqual({ c: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM seen_videos').get() as { c: number },
    ).toEqual({ c: 0 });
    const out = db
      .prepare('SELECT last_polled FROM person_outputs WHERE output_id = ?')
      .get(OUTPUT_ID) as { last_polled: string | null };
    expect(out.last_polled).toBeNull();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(meta).toMatchObject({ channelId: CHANNEL_ID });
  });

  it('Data API quota exhaustion → pass aborts before marking seen, so the row is retried (no Shorts leak)', async () => {
    insertFollower(USER_ID_A);
    // Steady state so the batch probe runs on the (one) unseen video.
    insertSeenVideo('priorvid001');
    const xml = rssXml({ entries: [{ videoId: 'quotavid001', title: 'Probed under quota exhaustion' }] });
    mockFetchOk(xml);
    // Quota is an API-path condition: the batched videos.list call itself
    // rejects, unlike a per-id flake (which the resolver swallows to "unknown").
    // So override the batched resolver, not the per-id probe.
    vi.mocked(videoDurations).mockRejectedValue(
      Object.assign(new Error('quotaExceeded'), { quotaExceeded: true }),
    );

    // Propagates rather than failing open — the caller (runRssPollPass) stands
    // the pass down on this.
    await expect(pollChannel(OUTPUT)).rejects.toMatchObject({ quotaExceeded: true });

    // No candidate enqueued, and the video stays UNSEEN so the next pass retries
    // it once quota resets — the regression this guards against was treating the
    // exhaustion as "unknown duration" and queueing the item (Shorts included).
    expect(subscriptionCandidates(USER_ID_A)).toHaveLength(0);
    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ? AND video_id = ?')
      .get(CHANNEL_ID, 'quotavid001');
    expect(seen).toBeUndefined();
  });

  it('applyChannelInfoToPerson rejecting does not bubble (fire-and-forget bio/photo refresh)', async () => {
    insertFollower(USER_ID_A);
    vi.mocked(applyChannelInfoToPerson).mockRejectedValueOnce(new Error('yt-dlp flaked'));

    const xml = rssXml({
      entries: [{ videoId: 'normalvid01', title: 'Normal upload' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await expect(pollChannel(OUTPUT)).resolves.toBeUndefined();

    // Let the rejected fire-and-forget settle.
    await new Promise((resolve) => setImmediate(resolve));

    // Poll still produced the subscription candidate.
    const candidates = subscriptionCandidates(USER_ID_A);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.external_id).toBe('normalvid01');

    expect(vi.mocked(logger.debug)).toHaveBeenCalled();
    const lastDebug = vi.mocked(logger.debug).mock.calls.at(-1);
    expect(lastDebug?.[0]).toMatchObject({ channelId: CHANNEL_ID });
  });
});
