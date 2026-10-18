import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// recoverInputs against a real DB file with the Data API client mocked: it
// never makes a network call. Fixtures are synthetic.

vi.mock('../../db/client', () => {
  throw new Error('src/db/client.ts must not be imported by the recover path');
});

vi.mock('../../config', () => ({
  config: { OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

const fetchVideoMetadata = vi.fn();
vi.mock('../../youtubeapi', () => ({
  fetchVideoMetadata: (ids: string[]) => fetchVideoMetadata(ids),
}));

import { readRecoveredInputs, recoveredInputsPath } from './util';
import { RECOVER_BATCH_SIZE, recoverInputs, snapshotToFile, summariseDataset, readDataset } from './index';

const KID = '11111111-1111-7111-8111-111111111111';
const PARENT = '33333333-3333-7333-8333-333333333333';
const AT = '2026-09-19T12:00:00.000Z';
const NOW = new Date('2026-10-18T08:00:00.000Z');

let dir: string;
let dbFile: string;

function video(id: string): { title: string; channel: string; channelId: string } {
  return { title: `Placeholder title ${id}`, channel: 'Placeholder channel', channelId: 'UC-placeholder' };
}

// Answer every id except the ones listed as unavailable.
function api(unavailable: readonly string[] = []) {
  return async (ids: string[]) => new Map(ids.filter((id) => !unavailable.includes(id)).map((id) => [id, video(id)]));
}

function makeDb(opts: { pruned: number; kept?: number; withoutYoutubeId?: number }): void {
  const migrations = path.join(__dirname, '../../db/migrations');
  const db = new Database(dbFile);
  for (const f of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(path.join(migrations, f), 'utf8'));
  }
  const user = db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  user.run(KID, 'Boy1', 'kid', 1, 2012, AT);
  user.run(PARENT, 'Parent', 'parent', 0, null, AT);
  const decision = db.prepare(`
    INSERT INTO guard_decisions (decision_id, subject_type, subject_id, user_id, url, youtube_id, age_band,
                                 rubric_version, source, guard_verdict, human_verdict, decided_by, decided_at)
    VALUES (?, ?, ?, ?, 'https://example.invalid/placeholder', ?, '10-12', 'rubric-v1.3', 'spot_check', 'clear_yes',
            'clear_yes', ?, ?)
  `);
  const metadata = db.prepare(`
    INSERT INTO video_metadata (youtube_id, description, tags_json, category_id, age_restricted, made_for_kids, fetched_at)
    VALUES (?, NULL, NULL, '27', 0, 1, ?)
  `);
  for (let i = 0; i < opts.pruned; i++) {
    const n = String(i).padStart(3, '0');
    decision.run(`d-${n}`, 'candidate', `c-gone-${n}`, KID, `yt-${n}`, PARENT, AT);
    metadata.run(`yt-${n}`, AT);
  }
  for (let i = 0; i < (opts.kept ?? 0); i++) {
    db.prepare(`
      INSERT INTO candidate_pool (candidate_id, user_id, source_type, url, external_id, title, channel, status, created_at)
      VALUES (?, ?, 'interest_search', 'https://example.invalid/c', ?, 'Placeholder title', 'Placeholder channel', 'guard_pending', ?)
    `).run(`c-kept-${i}`, KID, `yt-kept-${i}`, AT);
    decision.run(`d-kept-${i}`, 'candidate', `c-kept-${i}`, KID, `yt-kept-${i}`, PARENT, AT);
  }
  for (let i = 0; i < (opts.withoutYoutubeId ?? 0); i++) {
    decision.run(`d-noid-${i}`, 'candidate', `c-noid-${i}`, KID, null, PARENT, AT);
  }
  // A request decision is never looked up, row or no row.
  decision.run('d-request', 'request', 'r-gone', KID, 'yt-request', PARENT, AT);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'guard-harness-recover-'));
  dbFile = path.join(dir, 'eddy.db');
  fetchVideoMetadata.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recoverInputs', () => {
  it('fetches pruned candidates in batches of 50 through the Data API client and writes them 0600', async () => {
    makeDb({ pruned: 120, kept: 2, withoutYoutubeId: 1 });
    fetchVideoMetadata.mockImplementation(api(['yt-007', 'yt-100']));
    const before = readFileSync(dbFile);

    const r = await recoverInputs(dbFile, { now: () => NOW });

    expect(fetchVideoMetadata.mock.calls.map(([ids]) => (ids as string[]).length)).toEqual([50, 50, 20]);
    expect(RECOVER_BATCH_SIZE).toBe(50);
    expect(r).toMatchObject({
      missing: 121, alreadyHad: 0, noYoutubeId: 1, recovered: 118, unavailable: 2, notAttempted: 0, stoppedBy: null,
    });
    expect(r.recoveredPath).toBe(path.join(dir, 'harness', 'recovered-inputs.jsonl'));
    expect(statSync(r.recoveredPath).mode & 0o777).toBe(0o600);
    const line = JSON.parse(readFileSync(r.recoveredPath, 'utf8').split('\n')[0]!) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(['channel', 'channel_id', 'decision_id', 'fetched_at', 'title', 'youtube_id']);
    expect(line).toMatchObject({ decision_id: 'd-000', youtube_id: 'yt-000', fetched_at: NOW.toISOString() });
    // Read-only: the DB is untouched.
    expect(readFileSync(dbFile).equals(before)).toBe(true);
  });

  it('skips decisions already recovered, and refetches them with force', async () => {
    makeDb({ pruned: 3 });
    fetchVideoMetadata.mockImplementation(api(['yt-002']));
    await recoverInputs(dbFile, { now: () => NOW });

    fetchVideoMetadata.mockClear();
    fetchVideoMetadata.mockImplementation(api());
    const again = await recoverInputs(dbFile, { now: () => NOW });
    // The unavailable one is tried again; the recovered ones are not.
    expect(fetchVideoMetadata.mock.calls).toEqual([[['yt-002']]]);
    expect(again).toMatchObject({ missing: 3, alreadyHad: 2, recovered: 1, unavailable: 0 });

    fetchVideoMetadata.mockClear();
    const forced = await recoverInputs(dbFile, { force: true, now: () => NOW });
    expect(fetchVideoMetadata).toHaveBeenCalledTimes(1);
    expect(forced).toMatchObject({ missing: 3, alreadyHad: 0, recovered: 3 });
    expect(readRecoveredInputs(recoveredInputsPath(dbFile)).size).toBe(3);
  });

  it('makes no call when nothing is missing', async () => {
    makeDb({ pruned: 0, kept: 1 });
    const r = await recoverInputs(dbFile);
    expect(fetchVideoMetadata).not.toHaveBeenCalled();
    expect(r).toMatchObject({ missing: 0, recovered: 0 });
    expect(existsSync(recoveredInputsPath(dbFile))).toBe(false);
  });

  it('keeps what was fetched when the API stops part-way, and says why', async () => {
    makeDb({ pruned: 60 });
    fetchVideoMetadata
      .mockImplementationOnce(api())
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('YouTube API videos returned 403'), { quotaExceeded: true });
      });
    const r = await recoverInputs(dbFile, { now: () => NOW });
    expect(r).toMatchObject({
      missing: 60, recovered: 50, notAttempted: 10,
      stoppedBy: { message: 'YouTube API videos returned 403', quotaExceeded: true },
    });
    expect(readRecoveredInputs(recoveredInputsPath(dbFile)).size).toBe(50);
  });

  it('feeds the snapshot, which marks those items recovered', async () => {
    makeDb({ pruned: 2, withoutYoutubeId: 1 });
    fetchVideoMetadata.mockImplementation(api());
    await recoverInputs(dbFile, { now: () => NOW });
    const s = snapshotToFile(dbFile, NOW);
    expect(summariseDataset(readDataset(s.datasetPath)).byInputs).toEqual({ recovered: 2 });
    // The decision with no YouTube id and the request are still missing.
    expect(s.dropped.subject_missing).toBe(2);
  });
});
