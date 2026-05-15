import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// `:memory:` SQLite is the test fixture, mirroring the pattern in
// `requests/state.test.ts`. Real ports (queue, ntfy, registry, yt-dlp) are
// either mocked at module level (`videoDuration`, `applyChannelInfoToPerson`,
// `fetch`) or wired through a fake `Ports` object registered into the
// requests state — so assertions hit on-disk DB rows for `requests` /
// `seen_videos` / `person_outputs` while side-effect calls land on spies.
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

vi.mock('../../ytdlp', () => ({
  videoDuration: vi.fn(),
}));

vi.mock('./registry', () => ({
  ensurePersonForChannel: vi.fn(),
  applyChannelInfoToPerson: vi.fn(),
}));

// `state-default` statically imports queue (BullMQ + Redis) and
// notifications (ntfy) at module load. We replace both with no-op fakes so
// the test never opens a Redis socket; the state machine itself goes
// through the `Ports` seam wired below.
vi.mock('../../queue', () => ({
  redis: { del: vi.fn().mockResolvedValue(1) },
  downloadQueue: { add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(null) },
  deleteQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../notifications', () => ({
  getNotifications: () => ({ notify: vi.fn().mockResolvedValue(undefined) }),
}));

import { db } from '../../db/client';
import { logger } from '../../logger';
import { runMigrations } from '../../db/migrate';
import { videoDuration } from '../../ytdlp';
import { applyChannelInfoToPerson } from './registry';
import {
  createRequestsState,
  type Ports,
  type RequestsState,
} from '../requests/state';
import { registerDefaultRequestsState } from '../requests/state-default';
import { pollChannel, type OutputRow } from './poller';

// `parseYoutubeRss` is private to the module, so its three acceptance bullets
// (HTML-entity decoding, missing-thumbnail safety, multi-entry ordering) are
// driven through `pollChannel`. The decoded title round-trips into the
// `requests.title` column, a feed with no `<media:thumbnail>` parses without
// throwing, and a multi-entry feed queues the first entry (the latest upload)
// on first-poll confirmation.

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

function makeFakePorts(): Ports {
  return {
    notifyVideoReady: vi.fn().mockResolvedValue(undefined),
    enqueueDownload: vi.fn().mockResolvedValue(undefined),
    enqueueDelete: vi.fn().mockResolvedValue(undefined),
    cancelDownloadJob: vi.fn().mockResolvedValue(undefined),
    redisDel: vi.fn().mockResolvedValue(1),
    ensurePerson: vi.fn().mockReturnValue({ personId: PERSON_ID, created: false }),
    applyChannelInfo: vi.fn().mockResolvedValue(undefined),
  };
}

let fakePorts: Ports;
let state: RequestsState;

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

beforeAll(() => {
  runMigrations();
  insertUser(USER_ID_A, 'Boy1');
  insertUser(USER_ID_B, 'Boy2');
});

beforeEach(() => {
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM seen_videos');
  db.exec('DELETE FROM followed_people');
  db.exec('DELETE FROM person_outputs');
  db.exec('DELETE FROM people');

  insertPerson();
  insertPersonOutput();

  fakePorts = makeFakePorts();
  state = createRequestsState({ ports: fakePorts });
  registerDefaultRequestsState(state);

  vi.mocked(videoDuration).mockReset();
  vi.mocked(applyChannelInfoToPerson).mockReset();
  vi.mocked(applyChannelInfoToPerson).mockResolvedValue(undefined);
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.debug).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.unstubAllGlobals();
});

// ─── parseYoutubeRss (exercised through pollChannel) ────────────────────────

describe('parseYoutubeRss (via pollChannel)', () => {
  it('decodes HTML entities in <title> (&amp;, &#39;, &quot;) on the queued row', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        {
          videoId: 'vid1abcdefg',
          title: 'Lego &amp; Friends&#39;s &quot;best&quot; build',
        },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const row = db
      .prepare('SELECT title FROM requests WHERE user_id = ?')
      .get(USER_ID_A) as { title: string };
    expect(row.title).toBe(`Lego & Friends's "best" build`);
  });

  it('does not crash when an entry has no <media:thumbnail> (parses with thumbnailUrl: null)', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        { videoId: 'vidnothumb1', title: 'No thumbnail entry', thumbnailUrl: null },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await expect(pollChannel(OUTPUT)).resolves.toBeUndefined();

    const row = db
      .prepare('SELECT title FROM requests WHERE user_id = ?')
      .get(USER_ID_A) as { title: string };
    expect(row.title).toBe('No thumbnail entry');
  });

  it('yields multi-entry feeds in order — first entry is the most recent and the queued one on first poll', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        { videoId: 'newest12345', title: 'Newest' },
        { videoId: 'middle12345', title: 'Middle' },
        { videoId: 'oldest12345', title: 'Oldest' },
      ],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const rows = db
      .prepare('SELECT youtube_id, title FROM requests WHERE user_id = ?')
      .all(USER_ID_A) as Array<{ youtube_id: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.youtube_id).toBe('newest12345');
    expect(rows[0]?.title).toBe('Newest');

    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ? ORDER BY video_id')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen.map((s) => s.video_id).sort()).toEqual(
      ['middle12345', 'newest12345', 'oldest12345'].sort(),
    );
  });
});

// ─── pollChannel: first-poll confirmation ───────────────────────────────────

describe('pollChannel first-poll confirmation', () => {
  it('with empty seen_videos + 5 entries (latest non-short) → 1 request, 5 seen_videos rows', async () => {
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

    const requests = db
      .prepare('SELECT youtube_id FROM requests WHERE user_id = ?')
      .all(USER_ID_A) as Array<{ youtube_id: string }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.youtube_id).toBe('aaa11111111');

    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ?')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen).toHaveLength(5);
  });

  it('latest entry is a short → skipped before the confirmation slot is consumed; next non-short becomes the first download', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [
        { videoId: 'shortvid001', title: 'A short' },
        { videoId: 'longvid0001', title: 'A real video' },
        { videoId: 'longvid0002', title: 'Older video' },
      ],
    });
    mockFetchOk(xml);
    // First entry is a short (duration ≤ SHORTS_MAX_SECS), rest are long.
    vi.mocked(videoDuration).mockImplementation(async (id: string) => {
      if (id === 'shortvid001') return 30;
      return 600;
    });

    await pollChannel(OUTPUT);

    const requests = db
      .prepare('SELECT youtube_id FROM requests WHERE user_id = ?')
      .all(USER_ID_A) as Array<{ youtube_id: string }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.youtube_id).toBe('longvid0001');

    // All three videos are marked seen — the short to suppress re-evaluation,
    // the queued one as the confirmation, and the older one as part of the
    // first-poll catch-up.
    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ?')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen.map((s) => s.video_id).sort()).toEqual(
      ['longvid0001', 'longvid0002', 'shortvid001'].sort(),
    );
  });

  it('videoDuration throwing → entry is not classified as a short and proceeds (better to download a short than drop a creator)', async () => {
    insertFollower(USER_ID_A);
    const xml = rssXml({
      entries: [{ videoId: 'flakyvid001', title: 'Flaky metadata' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockRejectedValue(new Error('yt-dlp 429'));

    await pollChannel(OUTPUT);

    const requests = db
      .prepare('SELECT youtube_id FROM requests WHERE user_id = ?')
      .all(USER_ID_A) as Array<{ youtube_id: string }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.youtube_id).toBe('flakyvid001');
  });
});

// ─── pollChannel: steady state ──────────────────────────────────────────────

describe('pollChannel steady state', () => {
  it('1 new entry against existing seen_videos → 1 request per follower, both marked seen', async () => {
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

    const requests = db
      .prepare('SELECT user_id, youtube_id FROM requests ORDER BY user_id')
      .all() as Array<{ user_id: string; youtube_id: string }>;
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.user_id).sort()).toEqual([USER_ID_A, USER_ID_B].sort());
    expect(requests.every((r) => r.youtube_id === 'brandnew001')).toBe(true);

    const seen = db
      .prepare('SELECT video_id FROM seen_videos WHERE channel_id = ?')
      .all(CHANNEL_ID) as Array<{ video_id: string }>;
    expect(seen.map((s) => s.video_id).sort()).toEqual(
      ['brandnew001', 'priorvid001', 'priorvid002'].sort(),
    );
  });

  it('per-user dedup: a follower who already has a requests row for the same youtube_id does not get a second one', async () => {
    insertFollower(USER_ID_A);
    insertFollower(USER_ID_B);
    insertSeenVideo('priorvid001');

    // USER_ID_A already has a request for the new video — should be skipped.
    db.prepare(
      `INSERT INTO requests
         (request_id, user_id, source, url, youtube_id, status, requested_at, added_at)
       VALUES (?, ?, 'share_sheet', ?, ?, 'ready', ?, ?)`,
    ).run(
      'req-existing-a',
      USER_ID_A,
      'https://www.youtube.com/watch?v=dupvid00001',
      'dupvid00001',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const xml = rssXml({
      entries: [{ videoId: 'dupvid00001', title: 'Already requested by A' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    const requests = db
      .prepare('SELECT user_id, youtube_id FROM requests WHERE youtube_id = ?')
      .all('dupvid00001') as Array<{ user_id: string; youtube_id: string }>;
    expect(requests).toHaveLength(2);
    // Exactly one row per user — A's existing 'ready' row is preserved, B
    // gets the new channel_subscription row.
    expect(requests.map((r) => r.user_id).sort()).toEqual([USER_ID_A, USER_ID_B].sort());
  });

  it('no followers → early return; no seen_videos writes, no requests writes, last_polled untouched', async () => {
    const xml = rssXml({
      entries: [{ videoId: 'orphanvid01', title: 'No-one is following' }],
    });
    mockFetchOk(xml);
    vi.mocked(videoDuration).mockResolvedValue(600);

    await pollChannel(OUTPUT);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number },
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
      db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number },
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
      db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number },
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

    // Poll still produced the channel-subscription request.
    const requests = db
      .prepare('SELECT youtube_id FROM requests WHERE user_id = ?')
      .all(USER_ID_A) as Array<{ youtube_id: string }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.youtube_id).toBe('normalvid01');

    expect(vi.mocked(logger.debug)).toHaveBeenCalled();
    const lastDebug = vi.mocked(logger.debug).mock.calls.at(-1);
    expect(lastDebug?.[0]).toMatchObject({ channelId: CHANNEL_ID });
  });
});
