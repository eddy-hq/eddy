import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Snapshot on an in-memory DB with real migrations. Fixtures are synthetic.

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
import { buildSnapshot, channelHistoryAsOf, summariseDataset } from './snapshot';
import { HOLDOUT_PERCENT, isHoldout, parseHarnessItem } from './util';

const KID_1 = '11111111-1111-7111-8111-111111111111';
const KID_2 = '22222222-2222-7222-8222-222222222222';
const PARENT = '33333333-3333-7333-8333-333333333333';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const DECIDED_AT = '2026-09-20T12:00:00.000Z';
const BEFORE = '2026-09-19T12:00:00.000Z';
const AFTER = '2026-09-21T12:00:00.000Z';

beforeAll(() => {
  runMigrations();
  const insertUser = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run(KID_1, 'Boy1', 'kid', 1, 2013, BEFORE);
  insertUser.run(KID_2, 'Boy2', 'kid', 1, 2015, BEFORE);
  insertUser.run(PARENT, 'Parent', 'parent', 0, null, BEFORE);
});

beforeEach(() => {
  db.exec('DELETE FROM guard_decision_revisions');
  db.exec('DELETE FROM guard_decisions');
  db.exec('DELETE FROM candidate_pool');
  db.exec('DELETE FROM requests');
  db.exec('DELETE FROM video_metadata');
});

function seedCandidate(id: string, opts: { yt?: string; title?: string | null; channel?: string | null } = {}): void {
  const yt = opts.yt ?? `yt-${id}`;
  db.prepare(`
    INSERT INTO candidate_pool (candidate_id, user_id, source_type, url, external_id, title, channel, status, created_at)
    VALUES (?, ?, 'interest_search', ?, ?, ?, ?, 'guard_pending', ?)
  `).run(id, KID_1, `https://www.youtube.com/watch?v=${yt}`, yt,
    opts.title === undefined ? 'Placeholder title' : opts.title,
    opts.channel === undefined ? 'Placeholder channel' : opts.channel, BEFORE);
}

function seedRequest(id: string, opts: {
  userId?: string; yt?: string; channel?: string; status?: string; source?: string;
  requestedAt?: string; decidedAt?: string | null; downloadedAt?: string | null;
} = {}): void {
  const yt = opts.yt ?? `yt-${id}`;
  db.prepare(`
    INSERT INTO requests (request_id, user_id, source, url, youtube_id, title, channel, description, status,
                          requested_at, decided_at, downloaded_at)
    VALUES (?, ?, ?, ?, ?, 'Placeholder title', ?, 'Placeholder description', ?, ?, ?, ?)
  `).run(id, opts.userId ?? KID_1, opts.source ?? 'recommended', `https://www.youtube.com/watch?v=${yt}`, yt,
    opts.channel ?? 'Placeholder channel', opts.status ?? 'ready', opts.requestedAt ?? BEFORE,
    opts.decidedAt === undefined ? null : opts.decidedAt, opts.downloadedAt === undefined ? null : opts.downloadedAt);
}

function seedMetadata(yt: string, opts: { ageRestricted?: boolean; madeForKids?: boolean | null } = {}): void {
  db.prepare(`
    INSERT INTO video_metadata (youtube_id, description, tags_json, category_id, age_restricted, made_for_kids, fetched_at)
    VALUES (?, 'Placeholder description', '["tag-a","tag-b"]', '27', ?, ?, ?)
  `).run(yt, opts.ageRestricted ? 1 : 0, opts.madeForKids === undefined ? 1 : opts.madeForKids === null ? null : opts.madeForKids ? 1 : 0, BEFORE);
}

function seedDecision(id: string, subjectType: 'candidate' | 'request', subjectId: string, opts: {
  yt?: string | null; label?: 'clear_yes' | 'clear_no'; decidedAt?: string; blockKind?: 'unsafe' | 'not_for_us' | null;
} = {}): void {
  db.prepare(`
    INSERT INTO guard_decisions (decision_id, subject_type, subject_id, user_id, url, youtube_id, age_band,
                                 rubric_version, source, guard_verdict, human_verdict, decided_by, decided_at,
                                 block_kind)
    VALUES (?, ?, ?, ?, 'https://example.invalid/placeholder', ?, '10-12', 'rubric-v1.3', 'escalation', 'uncertain', ?, ?, ?, ?)
  `).run(id, subjectType, subjectId, KID_1, opts.yt === undefined ? `yt-${subjectId}` : opts.yt,
    opts.label ?? 'clear_yes', PARENT, opts.decidedAt ?? DECIDED_AT, opts.blockKind ?? null);
}

describe('channel history as of the decision', () => {
  it('counts only requests that reached their state before the decision', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1');
    seedRequest('r-before-ready', { decidedAt: BEFORE });
    seedRequest('r-before-rejected', { status: 'rejected', decidedAt: BEFORE });
    seedRequest('r-after-ready', { decidedAt: AFTER });
    seedRequest('r-after-rejected', { status: 'rejected', decidedAt: AFTER });
    // Requested before but only downloaded after: not yet ready when decided.
    seedRequest('r-downloaded-after', { requestedAt: BEFORE, downloadedAt: AFTER });
    // Allowed before, downloaded before: counts. Downloaded before, allowed after: doesn't.
    seedRequest('r-both-before', { decidedAt: BEFORE, downloadedAt: BEFORE });
    seedRequest('r-allowed-after', { decidedAt: AFTER, downloadedAt: BEFORE });
    // No decided / downloaded time: requested_at stands in.
    seedRequest('r-requested-only-before', { requestedAt: BEFORE });
    seedRequest('r-requested-only-after', { requestedAt: AFTER });
    // Exactly at the decision time is not strictly before.
    seedRequest('r-same-instant', { decidedAt: DECIDED_AT });

    const { items } = buildSnapshot(db);
    expect(items).toHaveLength(1);
    expect(items[0]!.channelHistory).toEqual({ approved: 3, rejected: 1 });
  });

  it('excludes the decided item itself, parent picks, other kids and other channels', () => {
    seedRequest('r-subject', { status: 'ready', decidedAt: BEFORE });
    seedMetadata('yt-r-subject');
    seedDecision('d1', 'request', 'r-subject');
    // The same video as an earlier request row for the kid (e.g. the candidate
    // that became this pick) is the item itself, not history.
    seedRequest('r-same-video', { yt: 'yt-r-subject', decidedAt: BEFORE });
    seedRequest('r-parent-pick', { source: 'parent_pick', decidedAt: BEFORE });
    seedRequest('r-other-kid', { userId: KID_2, decidedAt: BEFORE });
    seedRequest('r-other-channel', { channel: 'Another channel', decidedAt: BEFORE });
    seedRequest('r-case', { channel: 'PLACEHOLDER CHANNEL', decidedAt: BEFORE });

    const { items } = buildSnapshot(db);
    expect(items[0]!.channelHistory).toEqual({ approved: 1, rejected: 0 });
  });

  it('is null when the item has no channel, as the live guard leaves the line out', () => {
    seedCandidate('c1', { channel: '  ' });
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1');
    expect(buildSnapshot(db).items[0]!.channelHistory).toBeNull();
  });

  it('a later decision sees the earlier one\'s outcome only once it happened', () => {
    seedRequest('r1', { decidedAt: BEFORE });
    expect(channelHistoryAsOf(db, { userId: KID_1, channel: 'placeholder channel', asOf: BEFORE }))
      .toEqual({ approved: 0, rejected: 0 });
    expect(channelHistoryAsOf(db, { userId: KID_1, channel: 'placeholder channel', asOf: DECIDED_AT }))
      .toEqual({ approved: 1, rejected: 0 });
  });
});

describe('item inputs', () => {
  it('carries the label, metadata and decision context', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1', { madeForKids: false });
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_no' });

    const [item] = buildSnapshot(db).items;
    expect(item).toMatchObject({
      itemId: 'd1', subjectType: 'candidate', subjectId: 'c1', label: 'clear_no', ageBand: '10-12',
      rubricVersion: 'rubric-v1.3', guardVerdict: 'uncertain', decisionSource: 'escalation',
      tags: ['tag-a', 'tag-b'], categoryId: '27', madeForKids: false, ageRestricted: false,
    });
    expect(item!.holdout).toBe(isHoldout('d1'));
  });

  it('finds metadata through the candidate when the decision has no youtube id', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1', { ageRestricted: true, madeForKids: null });
    seedDecision('d1', 'candidate', 'c1', { yt: null });
    const [item] = buildSnapshot(db).items;
    expect(item).toMatchObject({ ageRestricted: true, madeForKids: null });
  });
});

describe('dropped items', () => {
  it('drops and counts decisions missing a subject, a title or metadata', () => {
    seedCandidate('c-ok');
    seedMetadata('yt-c-ok');
    seedDecision('d-ok', 'candidate', 'c-ok');

    seedDecision('d-gone', 'candidate', 'c-gone');

    seedCandidate('c-untitled', { title: null });
    seedMetadata('yt-c-untitled');
    seedDecision('d-untitled', 'candidate', 'c-untitled');

    seedCandidate('c-nometa');
    seedDecision('d-nometa', 'candidate', 'c-nometa');

    seedRequest('r-nometa');
    seedDecision('d-r-nometa', 'request', 'r-nometa');

    const r = buildSnapshot(db);
    expect(r.decisions).toBe(5);
    expect(r.items.map((i) => i.itemId)).toEqual(['d-ok']);
    expect(r.dropped).toEqual({ subject_missing: 1, no_title: 1, no_metadata: 2 });
  });
});

describe('holdout', () => {
  it('is stable for a decision id and close to the target share', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `0190${i.toString(16).padStart(4, '0')}-0000-7000-8000-000000000000`);
    const first = ids.map(isHoldout);
    expect(ids.map(isHoldout)).toEqual(first);
    const share = (first.filter(Boolean).length / ids.length) * 100;
    expect(share).toBeGreaterThan(HOLDOUT_PERCENT - 3);
    expect(share).toBeLessThan(HOLDOUT_PERCENT + 3);
  });

  it('does not depend on what else is in the snapshot', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1');
    const alone = buildSnapshot(db).items.find((i) => i.itemId === 'd1')!.holdout;
    for (let i = 0; i < 20; i++) {
      seedCandidate(`c-extra-${i}`);
      seedMetadata(`yt-c-extra-${i}`);
      seedDecision(`d-extra-${i}`, 'candidate', `c-extra-${i}`);
    }
    expect(buildSnapshot(db).items.find((i) => i.itemId === 'd1')!.holdout).toBe(alone);
  });
});

describe('revised labels (#223)', () => {
  function seedRevision(id: string, decisionId: string, label: 'clear_yes' | 'clear_no', revisedAt: string): void {
    db.prepare(`
      INSERT INTO guard_decision_revisions (revision_id, decision_id, human_verdict, rubric_version, effect,
                                            revised_by, revised_at)
      VALUES (?, ?, ?, 'rubric-v1.3', 'label_only', ?, ?)
    `).run(id, decisionId, label, PARENT, revisedAt);
  }

  it('labels an unrevised decision with its first pass', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_no' });
    expect(buildSnapshot(db).items[0]).toMatchObject({ label: 'clear_no', firstPassLabel: 'clear_no', revisedAt: null });
  });

  it('labels with the latest revision and keeps the first pass beside it', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_yes' });
    seedRevision('rv1', 'd1', 'clear_no', AFTER);
    seedRevision('rv2', 'd1', 'clear_yes', '2026-09-22T12:00:00.000Z');
    seedRevision('rv3', 'd1', 'clear_no', '2026-09-23T12:00:00.000Z');
    const r = buildSnapshot(db);
    expect(r.items[0]).toMatchObject({
      label: 'clear_no', firstPassLabel: 'clear_yes', revisedAt: '2026-09-23T12:00:00.000Z',
      // The inputs stay as they stood at the first pass.
      decidedAt: DECIDED_AT,
    });
    expect(summariseDataset(r.items)).toMatchObject({ revised: 1, byLabel: { clear_no: 1 } });
  });

  it('breaks a tie on revised_at by insertion order', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_yes' });
    seedRevision('rv-b', 'd1', 'clear_no', AFTER);
    seedRevision('rv-a', 'd1', 'clear_yes', AFTER);
    expect(buildSnapshot(db).items[0]).toMatchObject({ label: 'clear_yes', revisedAt: AFTER });
  });

  it('reads a dataset line frozen before revisions as its first pass, and refuses a bad first-pass label', () => {
    const line = { itemId: 'd1', label: 'clear_no', title: 't', ageBand: '10-12', holdout: false, tags: [], channelHistory: null };
    expect(parseHarnessItem(line, 1)).toMatchObject({ label: 'clear_no', firstPassLabel: 'clear_no', revisedAt: null });
    expect(() => parseHarnessItem({ ...line, firstPassLabel: 'uncertain' }, 1)).toThrow(/firstPassLabel/);
  });

  it('reads a source DB from before the revisions table existed', () => {
    seedCandidate('c1');
    seedMetadata('yt-c1');
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_no' });
    db.exec('DROP TABLE guard_decision_revisions');
    try {
      expect(buildSnapshot(db).items[0]).toMatchObject({ label: 'clear_no', firstPassLabel: 'clear_no', revisedAt: null });
    } finally {
      db.exec(readFileSync(path.join(__dirname, '../../db/migrations/048_guard_decision_revisions.sql'), 'utf8'));
      db.exec(`ALTER TABLE guard_decision_revisions
                 ADD COLUMN block_kind TEXT CHECK (block_kind IN ('unsafe', 'not_for_us'))`);
    }
  });
});

describe('block kinds (#227)', () => {
  function seedRevision(id: string, decisionId: string, label: 'clear_yes' | 'clear_no', blockKind: string | null, revisedAt: string): void {
    db.prepare(`
      INSERT INTO guard_decision_revisions (revision_id, decision_id, human_verdict, block_kind, rubric_version, effect,
                                            revised_by, revised_at)
      VALUES (?, ?, ?, ?, 'rubric-v1.3', 'label_only', ?, ?)
    `).run(id, decisionId, label, blockKind, PARENT, revisedAt);
  }

  function seedItem(id: string): void {
    seedCandidate(id);
    seedMetadata(`yt-${id}`);
  }

  it("carries the first pass's kind on an unrevised Block, and none on an Allow", () => {
    seedItem('c1');
    seedItem('c2');
    seedItem('c3');
    seedItem('c4');
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_no', blockKind: 'unsafe' });
    seedDecision('d2', 'candidate', 'c2', { label: 'clear_no', blockKind: 'not_for_us' });
    seedDecision('d3', 'candidate', 'c3', { label: 'clear_no' });
    seedDecision('d4', 'candidate', 'c4', { label: 'clear_yes' });
    const r = buildSnapshot(db);
    expect(r.items.map((i) => [i.itemId, i.blockKind])).toEqual([
      ['d1', 'unsafe'], ['d2', 'not_for_us'], ['d3', null], ['d4', null],
    ]);
    expect(summariseDataset(r.items).byBlockKind).toEqual({ unsafe: 1, not_for_us: 1, unrecorded: 1 });
  });

  it('takes the kind from the latest revision, beside its label', () => {
    seedItem('c1');
    seedItem('c2');
    seedItem('c3');
    // Kind set later on an old Block.
    seedDecision('d1', 'candidate', 'c1', { label: 'clear_no' });
    seedRevision('rv1', 'd1', 'clear_no', 'not_for_us', AFTER);
    // Revised to Allow: no kind left behind.
    seedDecision('d2', 'candidate', 'c2', { label: 'clear_no', blockKind: 'unsafe' });
    seedRevision('rv2', 'd2', 'clear_yes', null, AFTER);
    // Revised to a Block by an older client: the kind is not recorded.
    seedDecision('d3', 'candidate', 'c3', { label: 'clear_yes' });
    seedRevision('rv3', 'd3', 'clear_no', 'unsafe', AFTER);
    seedRevision('rv4', 'd3', 'clear_yes', null, '2026-09-22T12:00:00.000Z');
    seedRevision('rv5', 'd3', 'clear_no', null, '2026-09-23T12:00:00.000Z');
    expect(buildSnapshot(db).items.map((i) => [i.itemId, i.label, i.blockKind])).toEqual([
      ['d1', 'clear_no', 'not_for_us'], ['d2', 'clear_yes', null], ['d3', 'clear_no', null],
    ]);
  });

  it('reads a dataset line frozen before block kinds as unrecorded, and refuses a bad kind', () => {
    const line = { itemId: 'd1', label: 'clear_no', title: 't', ageBand: '10-12', holdout: false, tags: [], channelHistory: null };
    expect(parseHarnessItem(line, 1).blockKind).toBeNull();
    expect(parseHarnessItem({ ...line, blockKind: 'not_for_us' }, 1).blockKind).toBe('not_for_us');
    expect(() => parseHarnessItem({ ...line, blockKind: 'icky' }, 1)).toThrow(/blockKind/);
    expect(() => parseHarnessItem({ ...line, label: 'clear_yes', blockKind: 'unsafe' }, 1)).toThrow(/blockKind/);
  });

  it('reads a source DB from before block kinds existed', () => {
    const old = new Database(':memory:');
    try {
      for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '049').sort()) {
        old.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      }
      old.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(KID_1, 'Boy1', 'kid', 1, 2013, BEFORE);
      old.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(PARENT, 'Parent', 'parent', 0, null, BEFORE);
      old.prepare(`
        INSERT INTO candidate_pool (candidate_id, user_id, source_type, url, external_id, title, channel, status, created_at)
        VALUES ('c1', ?, 'interest_search', 'https://example.invalid/c1', 'yt-c1', 'Placeholder title', 'Placeholder channel', 'guard_pending', ?)
      `).run(KID_1, BEFORE);
      old.prepare(`
        INSERT INTO video_metadata (youtube_id, category_id, age_restricted, made_for_kids, fetched_at)
        VALUES ('yt-c1', '27', 0, 1, ?)
      `).run(BEFORE);
      old.prepare(`
        INSERT INTO guard_decisions (decision_id, subject_type, subject_id, user_id, url, youtube_id, age_band,
                                     rubric_version, source, guard_verdict, human_verdict, decided_by, decided_at)
        VALUES ('d1', 'candidate', 'c1', ?, 'https://example.invalid/c1', 'yt-c1', '10-12', 'rubric-v1.3', 'escalation',
                'uncertain', 'clear_no', ?, ?)
      `).run(KID_1, PARENT, DECIDED_AT);
      expect(buildSnapshot(old).items.map((i) => [i.label, i.blockKind])).toEqual([['clear_no', null]]);
    } finally {
      old.close();
    }
  });
});
