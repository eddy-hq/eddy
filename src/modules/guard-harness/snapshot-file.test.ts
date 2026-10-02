import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// snapshotToFile against a real DB file: read-only, never creates or changes
// the DB, never touches the shared writable connection. Fixtures are synthetic.

// The snapshot path must not import the shared writable connection: importing
// it opens (and for a missing path, creates) DATABASE_PATH.
vi.mock('../../db/client', () => {
  throw new Error('src/db/client.ts must not be imported by the snapshot path');
});

vi.mock('../../config', () => ({
  config: { OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

import { GuardHarnessError, readDataset, snapshotToFile } from './index';

const KID = '11111111-1111-7111-8111-111111111111';
const PARENT = '33333333-3333-7333-8333-333333333333';
const NOW = new Date('2026-10-02T08:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'guard-harness-snap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A DB file built from the real migrations, outside the app's connection.
function makeDb(file: string): void {
  const migrations = path.join(__dirname, '../../db/migrations');
  const db = new Database(file);
  for (const f of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(path.join(migrations, f), 'utf8'));
  }
  const at = '2026-09-19T12:00:00.000Z';
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(KID, 'Boy1', 'kid', 1, 2013, at);
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(PARENT, 'Parent', 'parent', 0, null, at);
  db.prepare(`
    INSERT INTO candidate_pool (candidate_id, user_id, source_type, url, external_id, title, channel, status, created_at)
    VALUES ('c1', ?, 'interest_search', 'https://example.invalid/c1', 'yt-c1', 'Placeholder title', 'Placeholder channel', 'guard_pending', ?)
  `).run(KID, at);
  db.prepare(`
    INSERT INTO video_metadata (youtube_id, description, tags_json, category_id, age_restricted, made_for_kids, fetched_at)
    VALUES ('yt-c1', NULL, NULL, '27', 0, 1, ?)
  `).run(at);
  db.prepare(`
    INSERT INTO guard_decisions (decision_id, subject_type, subject_id, user_id, url, youtube_id, age_band,
                                 rubric_version, source, guard_verdict, human_verdict, decided_by, decided_at)
    VALUES ('d1', 'candidate', 'c1', ?, 'https://example.invalid/c1', 'yt-c1', '10-12', 'rubric-v1.3', 'escalation',
            'uncertain', 'clear_yes', ?, '2026-09-20T12:00:00.000Z')
  `).run(KID, PARENT);
  db.close();
}

describe('snapshotToFile', () => {
  it('fails on a missing DB and creates nothing', () => {
    const missing = path.join(dir, 'missing.db');
    expect(() => snapshotToFile(missing, NOW)).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(path.join(dir, 'harness'))).toBe(false);
  });

  it('writes the dataset beside the DB and leaves the DB byte-for-byte unchanged', () => {
    const file = path.join(dir, 'eddy.db');
    makeDb(file);
    const before = readFileSync(file);

    const r = snapshotToFile(file, NOW);

    expect(r.datasetPath).toBe(path.join(dir, 'harness', 'dataset-2026-10-02.jsonl'));
    expect(readDataset(r.datasetPath).map((i) => i.itemId)).toEqual(['d1']);
    expect(readFileSync(file).equals(before)).toBe(true);
    // A read-only reader of a WAL DB may leave empty sidecar files; it never
    // writes a frame.
    if (existsSync(`${file}-wal`)) expect(statSync(`${file}-wal`).size).toBe(0);
  });

  it('refuses to overwrite a frozen dataset', () => {
    const file = path.join(dir, 'eddy.db');
    makeDb(file);
    snapshotToFile(file, NOW);
    expect(() => snapshotToFile(file, NOW)).toThrow(GuardHarnessError);
  });
});
