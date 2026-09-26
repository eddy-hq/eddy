import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'gemma4:e4b',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
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
  profileEnrichmentQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import {
  recomputeBehaviouralSnapshot,
  recomputeTrustWeights,
} from './index';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const PERSON_A = '22222222-2222-7222-8222-22222222aaaa';
const PERSON_B = '22222222-2222-7222-8222-22222222bbbb';
const CHANNEL_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CHANNEL_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

interface WatchEventInsert {
  request_id: string;
  video_id: string;
  channel_id: string;
  reason: 'ended' | 'dismissed' | 'navigated' | 'backgrounded';
  position_s?: number;
  duration_s?: number;
}

function insertRequest(opts: { request_id: string; video_id: string; channel_id: string | null }): void {
  db.prepare(`
    INSERT INTO requests
      (request_id, user_id, source, url, youtube_id, youtube_channel_id, status, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.request_id, USER_ID, 'discovery',
    `https://www.youtube.com/watch?v=${opts.video_id}`,
    opts.video_id, opts.channel_id,
    'ready', new Date().toISOString(),
  );
}

function insertWatchEvent(opts: WatchEventInsert): void {
  // First make sure the request row exists; watch_events itself has no FK
  // on request_id, but the snapshot join goes via requests.
  const existing = db.prepare('SELECT 1 FROM requests WHERE request_id = ?').get(opts.request_id);
  if (!existing) {
    insertRequest({
      request_id: opts.request_id,
      video_id: opts.video_id,
      channel_id: opts.channel_id,
    });
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO watch_events
      (event_id, user_id, request_id, video_id, source, started_at, ended_at,
       position_s, duration_s, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `evt-${opts.request_id}-${opts.reason}-${Math.random().toString(36).slice(2, 8)}`,
    USER_ID, opts.request_id, opts.video_id, 'discovery',
    now, now,
    opts.position_s ?? 0,
    opts.duration_s ?? 600,
    opts.reason,
  );
}

function insertCandidateDismiss(opts: {
  candidate_id: string;
  external_id: string;
  person_id: string | null;
}): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, person_id,
       url, external_id, status, created_at)
    VALUES (?, ?, 'video', 'person_backcatalog', ?, ?, ?, 'dismissed', ?)
  `).run(
    opts.candidate_id, USER_ID, opts.person_id,
    `https://www.youtube.com/watch?v=${opts.external_id}`,
    opts.external_id,
    new Date().toISOString(),
  );
}

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON_A, 'Person A', 'individual', new Date().toISOString());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON_B, 'Person B', 'individual', new Date().toISOString());
  db.prepare(`
    INSERT INTO person_outputs
      (output_id, person_id, output_type, fetcher_type, feed_url, external_id, active)
    VALUES (?, ?, 'youtube', 'youtube-rss', ?, ?, 1)
  `).run('out-a', PERSON_A, `https://example/${CHANNEL_A}`, CHANNEL_A);
  db.prepare(`
    INSERT INTO person_outputs
      (output_id, person_id, output_type, fetcher_type, feed_url, external_id, active)
    VALUES (?, ?, 'youtube', 'youtube-rss', ?, ?, 1)
  `).run('out-b', PERSON_B, `https://example/${CHANNEL_B}`, CHANNEL_B);
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, 1.0, ?, 'manual')
  `).run(USER_ID, PERSON_A, new Date().toISOString());
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, 1.0, ?, 'manual')
  `).run(USER_ID, PERSON_B, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM behavioural_signals');
  db.exec('DELETE FROM watch_events');
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  db.prepare('UPDATE followed_people SET trust_weight = 1.0 WHERE user_id = ?').run(USER_ID);
});

function getTrust(personId: string): number {
  const row = db.prepare(
    'SELECT trust_weight FROM followed_people WHERE user_id = ? AND person_id = ?'
  ).get(USER_ID, personId) as { trust_weight: number };
  return row.trust_weight;
}

describe('recomputeBehaviouralSnapshot + recomputeTrustWeights', () => {
  it('keeps trust at 1.0 below the cold-start floor', () => {
    // 3 watched, 0 dismissed — total < 5
    for (let i = 0; i < 3; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`,
        video_id: `vid-a-${i}`,
        channel_id: CHANNEL_A,
        reason: 'ended',
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(1.0);
  });

  it('moves trust to 1.5 when every event in a sample is a watch', () => {
    for (let i = 0; i < 5; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`,
        video_id: `vid-a-${i}`,
        channel_id: CHANNEL_A,
        reason: 'ended',
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(1.5);
  });

  it('moves trust to 0.5 when every event in a sample is a dismiss', () => {
    for (let i = 0; i < 5; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`,
        video_id: `vid-a-${i}`,
        channel_id: CHANNEL_A,
        reason: 'dismissed',
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(0.5);
  });

  it('respects the watched ratio threshold (≥0.9 of duration counts as watched)', () => {
    insertWatchEvent({
      request_id: 'req-ratio-1', video_id: 'vid-ratio-1', channel_id: CHANNEL_A,
      reason: 'navigated', position_s: 540, duration_s: 600,    // 0.9 exact
    });
    insertWatchEvent({
      request_id: 'req-ratio-2', video_id: 'vid-ratio-2', channel_id: CHANNEL_A,
      reason: 'navigated', position_s: 530, duration_s: 600,    // 0.883 — short
    });
    // four more watched so we cross the floor
    for (let i = 0; i < 4; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`, video_id: `vid-a-${i}`, channel_id: CHANNEL_A,
        reason: 'ended',
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    const row = db.prepare(
      'SELECT watched_count FROM behavioural_signals WHERE user_id = ? AND person_id = ?'
    ).get(USER_ID, PERSON_A) as { watched_count: number };
    // 4 'ended' + 1 'navigated at 0.9' = 5
    expect(row.watched_count).toBe(5);
  });

  it('counts a watch_events-only dismiss', () => {
    // 1 dismiss in watch_events, 4 dismisses pre-play to cross floor — but
    // those pre-play dismisses are for distinct candidates so they aren't
    // deduplicated. Result: 5 dismissed, 0 watched → trust 0.5.
    insertWatchEvent({
      request_id: 'req-watch-dismiss', video_id: 'vid-wd', channel_id: CHANNEL_A,
      reason: 'dismissed',
    });
    for (let i = 0; i < 4; i++) {
      insertCandidateDismiss({
        candidate_id: `cand-pre-${i}`,
        external_id: `vid-pre-${i}`,
        person_id: PERSON_A,
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(0.5);
  });

  it('counts plays of a parent pick (#217) as ordinary watch weight', () => {
    insertWatchEvent({
      request_id: 'req-parent-pick', video_id: 'vid-pp', channel_id: CHANNEL_A,
      reason: 'ended',
    });
    db.prepare("UPDATE requests SET source = 'parent_pick' WHERE request_id = 'req-parent-pick'").run();

    recomputeBehaviouralSnapshot(USER_ID);

    const row = db.prepare('SELECT watched_count FROM behavioural_signals WHERE user_id = ? AND person_id = ?')
      .get(USER_ID, PERSON_A) as { watched_count: number } | undefined;
    expect(row?.watched_count).toBe(1);
  });

  it('counts a player-side delete (requests.status=deleted) as a dismiss signal', () => {
    // Five videos arrived (any source) and the user deleted them from the
    // player view. The aggregator should treat each as a dismiss against the
    // attributed person, mirroring how a pre-play swipe-dismiss would count.
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO requests
          (request_id, user_id, source, url, youtube_id, youtube_channel_id,
           status, requested_at, deleted_at, file_state)
        VALUES (?, ?, ?, ?, ?, ?, 'deleted', ?, ?, 'gone')
      `).run(
        `req-del-${i}`, USER_ID, 'share_sheet',
        `https://www.youtube.com/watch?v=vid-del-${i}`,
        `vid-del-${i}`, CHANNEL_A,
        new Date().toISOString(), new Date().toISOString(),
      );
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(0.5);
  });

  it('counts a candidate_pool-only dismiss', () => {
    for (let i = 0; i < 5; i++) {
      insertCandidateDismiss({
        candidate_id: `cand-pre-${i}`,
        external_id: `vid-pre-${i}`,
        person_id: PERSON_A,
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(0.5);
  });

  it('deduplicates when watch_events and candidate_pool both flag the same video', () => {
    // Same video appears in both sources for person A — should count as one
    // dismiss, not two. Four other unique dismisses cross the floor at total=5,
    // so the deduped value is required to read 0.5; if it leaked through as 6
    // the floor would still be crossed but the test would still read 0.5, so
    // we instead verify the count directly.
    insertWatchEvent({
      request_id: 'req-dup', video_id: 'vid-dup', channel_id: CHANNEL_A,
      reason: 'dismissed',
    });
    insertCandidateDismiss({
      candidate_id: 'cand-dup',
      external_id: 'vid-dup',
      person_id: PERSON_A,
    });

    recomputeBehaviouralSnapshot(USER_ID);

    const row = db.prepare(
      'SELECT dismissed_count FROM behavioural_signals WHERE user_id = ? AND person_id = ?'
    ).get(USER_ID, PERSON_A) as { dismissed_count: number };
    expect(row.dismissed_count).toBe(1);
  });

  it('keeps per-person scopes independent', () => {
    // Person A: all watched. Person B: all dismissed.
    for (let i = 0; i < 5; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`, video_id: `vid-a-${i}`, channel_id: CHANNEL_A,
        reason: 'ended',
      });
      insertWatchEvent({
        request_id: `req-b-${i}`, video_id: `vid-b-${i}`, channel_id: CHANNEL_B,
        reason: 'dismissed',
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(1.5);
    expect(getTrust(PERSON_B)).toBe(0.5);
  });

  it('resets stale trust when a person drops out of the snapshot', () => {
    // First run: Person A goes to 1.5
    for (let i = 0; i < 5; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`, video_id: `vid-a-${i}`, channel_id: CHANNEL_A,
        reason: 'ended',
      });
    }
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);
    expect(getTrust(PERSON_A)).toBe(1.5);

    // Then all the underlying events vanish (e.g. request hard-delete + watch_events GC).
    db.exec('DELETE FROM watch_events');
    db.exec('DELETE FROM requests');
    recomputeBehaviouralSnapshot(USER_ID);
    recomputeTrustWeights(USER_ID);

    expect(getTrust(PERSON_A)).toBe(1.0);
  });

  it('writes recomputed_at on the snapshot rows', () => {
    for (let i = 0; i < 5; i++) {
      insertWatchEvent({
        request_id: `req-a-${i}`, video_id: `vid-a-${i}`, channel_id: CHANNEL_A,
        reason: 'ended',
      });
    }
    const before = new Date().toISOString();
    recomputeBehaviouralSnapshot(USER_ID);
    const row = db.prepare(
      'SELECT recomputed_at FROM behavioural_signals WHERE user_id = ? AND person_id = ?'
    ).get(USER_ID, PERSON_A) as { recomputed_at: string };
    expect(row.recomputed_at >= before).toBe(true);
  });
});
