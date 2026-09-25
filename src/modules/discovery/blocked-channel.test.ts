import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Blocked channels on the discovery side: the surface filter (defence in
// depth for rows already in the pool) and the purge a block triggers. Real
// migrations on an in-memory DB; fixtures are synthetic.

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
  discoveryQueue: { add: vi.fn() },
  guardQueue: {},
  downloadQueue: {},
  thumbsQueue: {},
  deleteQueue: {},
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { surfaceForToday, readScoredCandidatesByBucket } from './surface';
import { blockChannel } from './blocked-channel';
import { getBlockedChannel } from '../blocked-channels';

const KID_1 = '11111111-1111-7111-8111-111111111111';
const KID_2 = '22222222-2222-7222-8222-222222222222';
const PARENT = '33333333-3333-7333-8333-333333333333';

const BLOCKED_ID = 'UCblockedblockedblocked0';
const OTHER_ID = 'UCotherotherotherother00';
const BLOCKED_NAME = 'Placeholder blocked channel';
const OTHER_NAME = 'Placeholder other channel';

function insertCandidate(id: string, opts: {
  userId?: string; status?: string; verdict?: string | null;
  channelId?: string | null; channel?: string | null;
} = {}): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, url, external_id, title,
       channel, channel_id, connection_score, quality_score, time_sensitivity, gemma_score,
       published_at, guard_verdict, status, created_at, why_text)
    VALUES (?, ?, 'video', 'interest_search', ?, ?, ?, ?, ?, 8, 8, 'evergreen', 6.4, ?, ?, ?, ?, 'Placeholder why')
  `).run(
    id, opts.userId ?? KID_1, `https://www.youtube.com/watch?v=${id}`, id, `Placeholder title ${id}`,
    opts.channel === undefined ? OTHER_NAME : opts.channel,
    opts.channelId === undefined ? OTHER_ID : opts.channelId,
    new Date(Date.now() - 86_400_000).toISOString(),
    opts.verdict === undefined ? 'clear_yes' : opts.verdict,
    opts.status ?? 'scored',
    new Date().toISOString(),
  );
}

function statusOf(id: string): string {
  return (db.prepare('SELECT status FROM candidate_pool WHERE candidate_id = ?').get(id) as { status: string }).status;
}

function block(): ReturnType<typeof blockChannel> {
  return blockChannel({ channelId: BLOCKED_ID, displayName: BLOCKED_NAME, reason: null, blockedBy: PARENT });
}

beforeAll(() => {
  runMigrations();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertUser.run(KID_1, 'Boy1', 'kid', 12, new Date().toISOString());
  insertUser.run(KID_2, 'Boy2', 'kid', 10, new Date().toISOString());
  insertUser.run(PARENT, 'Parent', 'parent', 0, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM blocked_channels');
});

describe('surface filter', () => {
  // Every candidate the slate considered (picked or cut on score): what the
  // SQL filter let through.
  function consideredIds(userId: string, isKid: boolean): string[] {
    return surfaceForToday(userId, isKid, 15)
      .map((v) => v.candidate.candidateId)
      .sort();
  }

  it("keeps a blocked channel's rows already in the pool off a kid's slate", () => {
    insertCandidate('ok1');
    insertCandidate('blk1', { channelId: BLOCKED_ID, channel: BLOCKED_NAME });
    db.prepare(`INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)`)
      .run(BLOCKED_ID, BLOCKED_NAME, PARENT, new Date().toISOString());

    expect(consideredIds(KID_1, true)).toEqual(['ok1']);
  });

  it('matches an older row with no channel id on the display name', () => {
    insertCandidate('ok1');
    insertCandidate('legacy1', { channelId: null, channel: BLOCKED_NAME });
    db.prepare(`INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)`)
      .run(BLOCKED_ID, BLOCKED_NAME, PARENT, new Date().toISOString());

    expect(consideredIds(KID_1, true)).toEqual(['ok1']);
  });

  it('does not let a name match override a different channel id', () => {
    insertCandidate('same-name', { channelId: OTHER_ID, channel: BLOCKED_NAME });
    db.prepare(`INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)`)
      .run(BLOCKED_ID, BLOCKED_NAME, PARENT, new Date().toISOString());

    expect(consideredIds(KID_1, true)).toEqual(['same-name']);
  });

  it("leaves an adult's slate alone", () => {
    insertCandidate('adult-blk', { userId: PARENT, channelId: BLOCKED_ID, channel: BLOCKED_NAME, verdict: null });
    db.prepare(`INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)`)
      .run(BLOCKED_ID, BLOCKED_NAME, PARENT, new Date().toISOString());

    expect(consideredIds(PARENT, false)).toEqual(['adult-blk']);
  });

  it('skips blocked rows in the kid guard recheck', () => {
    insertCandidate('ok1', { verdict: null });
    insertCandidate('blk1', { channelId: BLOCKED_ID, channel: BLOCKED_NAME, verdict: null });
    db.prepare(`INSERT INTO blocked_channels (channel_id, display_name, blocked_by, blocked_at) VALUES (?, ?, ?, ?)`)
      .run(BLOCKED_ID, BLOCKED_NAME, PARENT, new Date().toISOString());

    expect(readScoredCandidatesByBucket(KID_1, 12).map((c) => c.candidate_id)).toEqual(['ok1']);
  });
});

describe('blockChannel', () => {
  it("takes every kid's unpicked candidates from the channel out of the pool", () => {
    insertCandidate('k1-scored', { channelId: BLOCKED_ID, channel: BLOCKED_NAME });
    insertCandidate('k1-pending', { channelId: BLOCKED_ID, channel: BLOCKED_NAME, status: 'pending', verdict: null });
    insertCandidate('k2-parked', { userId: KID_2, channelId: BLOCKED_ID, channel: BLOCKED_NAME, status: 'guard_pending', verdict: 'uncertain' });
    insertCandidate('k2-legacy', { userId: KID_2, channelId: null, channel: BLOCKED_NAME });
    insertCandidate('k1-other', { channelId: OTHER_ID, channel: OTHER_NAME });

    const out = block();

    expect(out).toMatchObject({ channelId: BLOCKED_ID, alreadyBlocked: false, poolRowsRemoved: 4 });
    for (const id of ['k1-scored', 'k1-pending', 'k2-parked', 'k2-legacy']) expect(statusOf(id)).toBe('guard_rejected');
    expect(statusOf('k1-other')).toBe('scored');
    expect(getBlockedChannel(BLOCKED_ID)).toMatchObject({ displayName: BLOCKED_NAME, blockedBy: PARENT });
  });

  it("keeps the guard's verdict: the guard didn't judge this", () => {
    insertCandidate('k1-scored', { channelId: BLOCKED_ID, channel: BLOCKED_NAME, verdict: 'clear_yes' });
    block();
    const row = db.prepare('SELECT guard_verdict FROM candidate_pool WHERE candidate_id = ?').get('k1-scored') as { guard_verdict: string };
    expect(row.guard_verdict).toBe('clear_yes');
  });

  it('leaves picked and dismissed candidates, and adults, alone', () => {
    insertCandidate('k1-picked', { channelId: BLOCKED_ID, channel: BLOCKED_NAME, status: 'requested' });
    insertCandidate('k1-dismissed', { channelId: BLOCKED_ID, channel: BLOCKED_NAME, status: 'dismissed' });
    insertCandidate('adult-scored', { userId: PARENT, channelId: BLOCKED_ID, channel: BLOCKED_NAME });

    expect(block().poolRowsRemoved).toBe(0);
    expect(statusOf('k1-picked')).toBe('requested');
    expect(statusOf('k1-dismissed')).toBe('dismissed');
    expect(statusOf('adult-scored')).toBe('scored');
  });

  it('is idempotent, and a re-block still sweeps the pool', () => {
    block();
    insertCandidate('late', { channelId: BLOCKED_ID, channel: BLOCKED_NAME });
    const again = block();
    expect(again).toMatchObject({ alreadyBlocked: true, poolRowsRemoved: 1 });
  });
});
