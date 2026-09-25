import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Migration 045's candidate_pool.channel_id backfill, re-run over rows that
// predate it (a fresh test DB has none by the time the migration runs).

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

const KID = '11111111-1111-7111-8111-111111111111';
const SINGLE_ID = 'UCsinglesinglesingle0000';
const MULTI_A = 'UCmultiamultiamultia0000';
const MULTI_B = 'UCmultibmultibmultib0000';
const DOWNLOADED_ID = 'UCdownloadeddownloaded00';

function backfillStatements(): string[] {
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/045_blocked_channels.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  return sql.split(';').map((s) => s.trim()).filter((s) => s.startsWith('UPDATE candidate_pool'));
}

function insertCandidate(id: string, sourceType: string, personId: string | null): void {
  db.prepare(`
    INSERT INTO candidate_pool (candidate_id, user_id, source_type, person_id, url, external_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'scored', ?)
  `).run(id, KID, sourceType, personId, `https://www.youtube.com/watch?v=${id}`, id, new Date().toISOString());
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(KID, 'Boy1', 'kid', 12, now);
  const person = db.prepare('INSERT INTO people (person_id, display_name, created_at) VALUES (?, ?, ?)');
  const output = db.prepare(`INSERT INTO person_outputs (output_id, person_id, output_type, external_id, active) VALUES (?, ?, 'youtube', ?, 1)`);
  person.run('p-single', 'Placeholder single', now);
  output.run('o-single', 'p-single', SINGLE_ID);
  person.run('p-multi', 'Placeholder multi', now);
  output.run('o-multi-a', 'p-multi', MULTI_A);
  output.run('o-multi-b', 'p-multi', MULTI_B);

  insertCandidate('sub-single', 'subscription', 'p-single');
  insertCandidate('bc-multi', 'person_backcatalog', 'p-multi');
  insertCandidate('search-downloaded', 'interest_search', null);
  insertCandidate('search-unknown', 'interest_search', null);
  db.prepare(`
    INSERT INTO requests (request_id, user_id, source, url, youtube_id, youtube_channel_id, status, requested_at)
    VALUES ('r1', ?, 'recommended', 'https://www.youtube.com/watch?v=search-downloaded', 'search-downloaded', ?, 'ready', ?)
  `).run(KID, DOWNLOADED_ID, now);

  const statements = backfillStatements();
  expect(statements).toHaveLength(2);
  for (const s of statements) db.exec(s);
});

const channelOf = (id: string) =>
  (db.prepare('SELECT channel_id FROM candidate_pool WHERE candidate_id = ?').get(id) as { channel_id: string | null }).channel_id;

describe('045 channel_id backfill', () => {
  it("takes a follow-sourced row's channel from its person's only YouTube output", () => {
    expect(channelOf('sub-single')).toBe(SINGLE_ID);
  });

  it('leaves a multi-channel person unguessed', () => {
    expect(channelOf('bc-multi')).toBeNull();
  });

  it('takes the channel a download of the same video recorded', () => {
    expect(channelOf('search-downloaded')).toBe(DOWNLOADED_ID);
  });

  it('leaves a row it cannot place NULL (matched on display name instead)', () => {
    expect(channelOf('search-unknown')).toBeNull();
  });
});
