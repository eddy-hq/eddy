import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

// The guard is mocked wholesale: no Ollama, no Data API.
vi.mock('../guard/index', () => ({
  CANDIDATE_PROMPT_VERSION: 'candidate-v3',
  GUARD_SCORING_ERROR_REASON: 'Guard scoring error',
  evaluateCandidate: vi.fn(),
  ensureVideoMetadata: vi.fn(),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { evaluateCandidate, ensureVideoMetadata, type StoredVideoMetadata } from '../guard/index';
import {
  applyParkedRerun,
  evaluateParkedBacklog,
  readRerunResults,
  summariseRerun,
  writeRerunResults,
  ParkedRerunError,
  type ParkedRerunResult,
} from './parked-rerun';
import { statusForGuardVerdict } from './util';

const KID_1 = '11111111-1111-7111-8111-111111111111';
const KID_2 = '22222222-2222-7222-8222-222222222222';
const PARENT = '33333333-3333-7333-8333-333333333333';
const THIS_YEAR = new Date().getUTCFullYear();

const evaluateMock = vi.mocked(evaluateCandidate);
const metadataMock = vi.mocked(ensureVideoMetadata);

let dir: string;
let resultsPath: string;
let backupPath: string;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function insertCandidate(opts: {
  id: string;
  userId?: string;
  status?: string;
  guardVerdict?: string | null;
  createdAt?: string;
}): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, source_type, url, external_id, title, channel,
       status, guard_verdict, created_at)
    VALUES (?, ?, 'interest_search', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.userId ?? KID_1,
    `https://www.youtube.com/watch?v=${opts.id}`,
    opts.id,
    `Title ${opts.id}`,
    `Channel ${opts.id}`,
    opts.status ?? 'guard_pending',
    opts.guardVerdict === undefined ? 'uncertain' : opts.guardVerdict,
    opts.createdAt ?? daysAgo(30),
  );
}

function candidateRow(id: string): { status: string; guard_verdict: string | null } {
  return db.prepare('SELECT status, guard_verdict FROM candidate_pool WHERE candidate_id = ?')
    .get(id) as { status: string; guard_verdict: string | null };
}

function result(candidateId: string, newVerdict: ParkedRerunResult['newVerdict'], over: Partial<ParkedRerunResult> = {}): ParkedRerunResult {
  return {
    candidateId,
    userId: KID_1,
    oldVerdict: 'uncertain',
    newVerdict,
    ageRestricted: false,
    evaluatedAt: new Date().toISOString(),
    promptVersion: 'candidate-v3',
    ...over,
  };
}

function meta(id: string, over: Partial<StoredVideoMetadata> = {}): StoredVideoMetadata {
  return {
    youtubeId: id,
    description: `About ${id}`,
    tags: ['t'],
    categoryId: '27',
    ageRestricted: false,
    madeForKids: true,
    ...over,
  };
}

beforeAll(() => {
  runMigrations();
  const insert = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  insert.run(KID_1, 'Boy1', 'kid', 12, THIS_YEAR - 13, now);
  insert.run(KID_2, 'Boy2', 'kid', 10, THIS_YEAR - 10, now);
  insert.run(PARENT, 'Parent1', 'parent', 18, null, now);
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  evaluateMock.mockReset();
  metadataMock.mockReset();
  metadataMock.mockResolvedValue(new Map());
  dir = mkdtempSync(path.join(tmpdir(), 'parked-rerun-'));
  resultsPath = path.join(dir, 'parked-rerun.json');
  backupPath = path.join(dir, 'eddy.pre-parked-rerun.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('statusForGuardVerdict', () => {
  it('maps verdicts to the status discovery uses', () => {
    expect(statusForGuardVerdict('clear_yes')).toBe('scored');
    expect(statusForGuardVerdict('clear_no')).toBe('guard_rejected');
    expect(statusForGuardVerdict('uncertain')).toBe('guard_pending');
  });
});

describe('evaluateParkedBacklog', () => {
  it('guards parked kid candidates with metadata and never touches candidate_pool', async () => {
    insertCandidate({ id: 'a' });
    insertCandidate({ id: 'b', userId: KID_2 });
    insertCandidate({ id: 'adult', userId: PARENT });
    insertCandidate({ id: 'done', status: 'scored', guardVerdict: 'clear_yes' });
    metadataMock.mockResolvedValue(new Map([
      ['a', meta('a')],
      ['b', meta('b', { ageRestricted: true })],
    ]));
    evaluateMock.mockImplementation(async (p) =>
      p.ageRestricted
        ? { verdict: 'clear_no', reason: 'Age-restricted on YouTube', confidence: 1 }
        : { verdict: 'clear_yes', reason: 'Fine', confidence: 0.9 });

    const report = await evaluateParkedBacklog({ resultsPath });

    expect(report).toMatchObject({ parked: 2, alreadyEvaluated: 0, recorded: 2, scoringErrors: 0 });
    expect(metadataMock).toHaveBeenCalledWith(['a', 'b']);
    expect(evaluateMock).toHaveBeenCalledTimes(2);
    const first = evaluateMock.mock.calls[0]![0];
    expect(first).toMatchObject({
      candidateId: 'a',
      userId: KID_1,
      description: 'About a',
      tags: ['t'],
      categoryId: '27',
      madeForKids: true,
      ageRestricted: false,
    });
    // Each row uses its own user's age band.
    expect(first.ageBand).toBe('13-15');
    expect(evaluateMock.mock.calls[1]![0].ageBand).toBe('10-12');

    const results = readRerunResults(resultsPath);
    expect(results.map((r) => [r.candidateId, r.newVerdict, r.ageRestricted])).toEqual([
      ['a', 'clear_yes', false],
      ['b', 'clear_no', true],
    ]);
    expect(candidateRow('a')).toEqual({ status: 'guard_pending', guard_verdict: 'uncertain' });
    expect(candidateRow('b')).toEqual({ status: 'guard_pending', guard_verdict: 'uncertain' });
  });

  it('writes a results file with no title, channel, reason or url', async () => {
    insertCandidate({ id: 'a' });
    evaluateMock.mockResolvedValue({ verdict: 'uncertain', reason: 'Some reason', confidence: 0.4 });

    await evaluateParkedBacklog({ resultsPath });

    const raw = readFileSync(resultsPath, 'utf8');
    const entries = JSON.parse(raw) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!).sort()).toEqual(
      ['ageRestricted', 'candidateId', 'evaluatedAt', 'newVerdict', 'oldVerdict', 'promptVersion', 'userId'],
    );
    expect(raw).not.toMatch(/Title a|Channel a|Some reason|youtube\.com/);
    expect(existsSync(`${resultsPath}.tmp`)).toBe(false);
  });

  it('resumes: skips candidates already evaluated at the current prompt version', async () => {
    insertCandidate({ id: 'a', createdAt: daysAgo(3) });
    insertCandidate({ id: 'b', createdAt: daysAgo(2) });
    insertCandidate({ id: 'c', createdAt: daysAgo(1) });
    writeRerunResults(resultsPath, [
      result('a', 'clear_yes'),
      result('b', 'clear_yes', { promptVersion: 'candidate-v2' }),
    ]);
    evaluateMock.mockResolvedValue({ verdict: 'clear_no', reason: 'No', confidence: 0.9 });

    const report = await evaluateParkedBacklog({ resultsPath });

    expect(report).toMatchObject({ parked: 3, alreadyEvaluated: 1, recorded: 2 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['b', 'c']);
    const results = readRerunResults(resultsPath);
    expect(results.map((r) => [r.candidateId, r.newVerdict, r.promptVersion])).toEqual([
      ['a', 'clear_yes', 'candidate-v3'],
      ['b', 'clear_no', 'candidate-v3'],
      ['c', 'clear_no', 'candidate-v3'],
    ]);
  });

  it('--limit evaluates only the first N outstanding candidates', async () => {
    insertCandidate({ id: 'a', createdAt: daysAgo(3) });
    insertCandidate({ id: 'b', createdAt: daysAgo(2) });
    insertCandidate({ id: 'c', createdAt: daysAgo(1) });
    evaluateMock.mockResolvedValue({ verdict: 'uncertain', reason: 'Hm', confidence: 0.5 });

    await evaluateParkedBacklog({ resultsPath, limit: 2 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['a', 'b']);

    await evaluateParkedBacklog({ resultsPath, limit: 2 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['a', 'b', 'c']);
  });

  it('does not record model errors, and stops after repeated ones', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) insertCandidate({ id });
    evaluateMock
      .mockResolvedValueOnce({ verdict: 'clear_yes', reason: 'Fine', confidence: 0.9 })
      .mockResolvedValue({ verdict: 'uncertain', reason: 'Guard scoring error', confidence: 0 });

    const report = await evaluateParkedBacklog({ resultsPath });

    expect(report).toMatchObject({ attempted: 6, recorded: 1, scoringErrors: 5, abortedAfterErrors: true });
    expect(readRerunResults(resultsPath).map((r) => r.candidateId)).toEqual(['a']);
  });
});

describe('applyParkedRerun', () => {
  it('maps each verdict to the status discovery would set', async () => {
    insertCandidate({ id: 'yes' });
    insertCandidate({ id: 'no' });
    insertCandidate({ id: 'maybe' });
    writeRerunResults(resultsPath, [
      result('yes', 'clear_yes'),
      result('no', 'clear_no'),
      result('maybe', 'uncertain'),
    ]);

    const report = await applyParkedRerun({ resultsPath, backupPath });

    expect(report.applied).toEqual({ scored: 1, guard_rejected: 1, guard_pending: 1 });
    expect(candidateRow('yes')).toEqual({ status: 'scored', guard_verdict: 'clear_yes' });
    expect(candidateRow('no')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
    expect(candidateRow('maybe')).toEqual({ status: 'guard_pending', guard_verdict: 'uncertain' });
    expect(existsSync(backupPath)).toBe(true);
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('skips candidates whose status changed since evaluation', async () => {
    insertCandidate({ id: 'moved', status: 'guard_rejected', guardVerdict: 'clear_no' });
    insertCandidate({ id: 'still' });
    writeRerunResults(resultsPath, [
      result('moved', 'clear_yes'),
      result('gone', 'clear_yes'),
      result('still', 'clear_yes'),
      result('stale', 'clear_yes', { promptVersion: 'candidate-v2' }),
    ]);

    const report = await applyParkedRerun({ resultsPath, backupPath });

    expect(report.statusChanged).toBe(2);
    expect(report.staleVersion).toBe(1);
    expect(report.applied.scored).toBe(1);
    expect(candidateRow('moved')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
    expect(candidateRow('still')).toEqual({ status: 'scored', guard_verdict: 'clear_yes' });
  });

  it('refuses without a results file', async () => {
    insertCandidate({ id: 'a' });
    await expect(applyParkedRerun({ resultsPath, backupPath })).rejects.toBeInstanceOf(ParkedRerunError);
    expect(existsSync(backupPath)).toBe(false);
    expect(candidateRow('a').status).toBe('guard_pending');
  });

  it('refuses to overwrite an existing backup unless forced', async () => {
    insertCandidate({ id: 'a' });
    writeRerunResults(resultsPath, [result('a', 'clear_no')]);
    writeFileSync(backupPath, 'previous backup');

    await expect(applyParkedRerun({ resultsPath, backupPath })).rejects.toBeInstanceOf(ParkedRerunError);
    expect(readFileSync(backupPath, 'utf8')).toBe('previous backup');
    expect(candidateRow('a').status).toBe('guard_pending');

    const report = await applyParkedRerun({ resultsPath, backupPath, forceBackup: true });
    expect(report.applied.guard_rejected).toBe(1);
    expect(readFileSync(backupPath, 'utf8')).not.toBe('previous backup');
  });

  it('rejects a results file carrying an unknown verdict', async () => {
    insertCandidate({ id: 'a' });
    writeFileSync(resultsPath, JSON.stringify([{ ...result('a', 'clear_yes'), newVerdict: 'approve' }]));
    await expect(applyParkedRerun({ resultsPath, backupPath })).rejects.toBeInstanceOf(ParkedRerunError);
    expect(candidateRow('a').status).toBe('guard_pending');
  });
});

describe('summariseRerun', () => {
  it('counts transitions by kid placeholder, candidate age and age restriction', () => {
    insertCandidate({ id: 'r1', createdAt: daysAgo(3) });
    insertCandidate({ id: 'o1', createdAt: daysAgo(40) });
    insertCandidate({ id: 'o2', userId: KID_2, createdAt: daysAgo(20) });

    const s = summariseRerun([
      result('r1', 'clear_yes'),
      result('o1', 'clear_no', { ageRestricted: true }),
      result('o2', 'uncertain', { userId: KID_2 }),
      result('gone', 'clear_no', { userId: KID_2 }),
      result('old', 'clear_yes', { promptVersion: 'candidate-v2' }),
    ]);

    expect(s.total).toBe(4);
    expect(s.ageRestricted).toBe(1);
    expect(s.transitions).toEqual({
      'uncertain -> clear_yes': 1,
      'uncertain -> clear_no': 2,
      'uncertain -> uncertain': 1,
    });
    // Oldest kid is kid_1.
    expect(s.byUser).toEqual({
      kid_1: { 'uncertain -> clear_yes': 1, 'uncertain -> clear_no': 1 },
      kid_2: { 'uncertain -> uncertain': 1, 'uncertain -> clear_no': 1 },
    });
    expect(s.byCandidateAge.recent).toEqual({ 'uncertain -> clear_yes': 1 });
    expect(s.byCandidateAge.older).toEqual({ 'uncertain -> clear_no': 1, 'uncertain -> uncertain': 1 });
    expect(s.byCandidateAge.unknown).toEqual({ 'uncertain -> clear_no': 1 });
    expect(JSON.stringify(s)).not.toContain(KID_1);
  });
});
