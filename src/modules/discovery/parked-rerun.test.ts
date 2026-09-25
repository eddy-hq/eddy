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

// The guard is mocked wholesale: no Ollama, no Data API. The rubric's driver
// keys are pure, so the real function is used.
vi.mock('../guard/index', async () => {
  const rubric = await import('../guard/rubric');
  return {
    GUARD_SCORING_ERROR_REASON: 'Guard scoring error',
    rerunVersionKey: (p: string) => (p === 'v4' ? 'candidate-v4' : 'candidate-v3'),
    driverCountKey: rubric.driverCountKey,
    evaluateCandidate: vi.fn(),
    ensureVideoMetadata: vi.fn(),
  };
});

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { evaluateCandidate, ensureVideoMetadata, type CandidateVerdict, type StoredVideoMetadata } from '../guard/index';
import { verdictFromScores, type RubricScores } from '../guard/rubric';
import {
  applyParkedRerun,
  evaluateParkedBacklog,
  readRerunResults,
  sampleCandidates,
  samplesPathFor,
  summariseRerun,
  writeRerunResults,
  ParkedRerunError,
  type ParkedRerunResult,
} from './parked-rerun';
import { parseRerunArgs, resolveRerunPrompt } from './parked-rerun-args';
import { statusForGuardVerdict } from './util';

const KID_1 = '11111111-1111-7111-8111-111111111111';
const KID_2 = '22222222-2222-7222-8222-222222222222';
const PARENT = '33333333-3333-7333-8333-333333333333';
const THIS_YEAR = new Date().getUTCFullYear();

const evaluateMock = vi.mocked(evaluateCandidate);

// A v3-shaped guard verdict as evaluateCandidate returns it.
function gv(verdict: CandidateVerdict['verdict'], reason: string, confidence: number): CandidateVerdict {
  return { verdict, reason, confidence, promptVersion: 'candidate-v3', rubric: null };
}
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
    population: 'pending',
    durationMs: 1000,
    drivers: null,
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
  metadataMock.mockImplementation(async (ids) => new Map(ids.map((id) => [id, meta(id)])));
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
        ? gv('clear_no', 'Age-restricted on YouTube', 1)
        : gv('clear_yes', 'Fine', 0.9));

    const report = await evaluateParkedBacklog({ resultsPath, prompt: 'v3' });

    expect(report).toMatchObject({ eligible: 2, alreadyEvaluated: 0, recorded: 2, scoringErrors: 0 });
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
    evaluateMock.mockResolvedValue(gv('uncertain', 'Some reason', 0.4));

    await evaluateParkedBacklog({ resultsPath, prompt: 'v3' });

    const raw = readFileSync(resultsPath, 'utf8');
    const entries = JSON.parse(raw) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!).sort()).toEqual([
      'ageRestricted', 'candidateId', 'drivers', 'durationMs', 'evaluatedAt', 'newVerdict', 'oldVerdict',
      'population', 'promptVersion', 'userId',
    ]);
    expect(raw).not.toMatch(/Title a|Channel a|Some reason|youtube\.com/);
    expect(existsSync(`${resultsPath}.tmp`)).toBe(false);
  });

  it('resumes: skips candidates already evaluated at the chosen prompt version, keeping other versions', async () => {
    insertCandidate({ id: 'a', createdAt: daysAgo(3) });
    insertCandidate({ id: 'b', createdAt: daysAgo(2) });
    insertCandidate({ id: 'c', createdAt: daysAgo(1) });
    writeRerunResults(resultsPath, [
      result('a', 'clear_yes'),
      result('b', 'clear_yes', { promptVersion: 'candidate-v2' }),
    ]);
    evaluateMock.mockResolvedValue(gv('clear_no', 'No', 0.9));

    const report = await evaluateParkedBacklog({ resultsPath, prompt: 'v3' });

    expect(report).toMatchObject({ eligible: 3, alreadyEvaluated: 1, recorded: 2 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['b', 'c']);
    const results = readRerunResults(resultsPath);
    expect(results.map((r) => [r.candidateId, r.newVerdict, r.promptVersion])).toEqual([
      ['a', 'clear_yes', 'candidate-v3'],
      ['b', 'clear_yes', 'candidate-v2'],
      ['b', 'clear_no', 'candidate-v3'],
      ['c', 'clear_no', 'candidate-v3'],
    ]);
  });

  it('--limit evaluates only the first N outstanding candidates', async () => {
    insertCandidate({ id: 'a', createdAt: daysAgo(3) });
    insertCandidate({ id: 'b', createdAt: daysAgo(2) });
    insertCandidate({ id: 'c', createdAt: daysAgo(1) });
    evaluateMock.mockResolvedValue(gv('uncertain', 'Hm', 0.5));

    await evaluateParkedBacklog({ resultsPath, prompt: 'v3', limit: 2 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['a', 'b']);

    await evaluateParkedBacklog({ resultsPath, prompt: 'v3', limit: 2 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['a', 'b', 'c']);
  });

  it('leaves candidates without stored metadata unevaluated, for the next run', async () => {
    insertCandidate({ id: 'a', createdAt: daysAgo(2) });
    insertCandidate({ id: 'b', createdAt: daysAgo(1) });
    metadataMock.mockResolvedValue(new Map([['a', meta('a')]]));
    evaluateMock.mockResolvedValue(gv('clear_yes', 'Fine', 0.9));

    const report = await evaluateParkedBacklog({ resultsPath, prompt: 'v3' });
    expect(report).toMatchObject({ recorded: 1, missingMetadata: 1 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId)).toEqual(['a']);
    expect(readRerunResults(resultsPath).map((r) => r.candidateId)).toEqual(['a']);

    // Metadata arrives later: the next run picks b up.
    metadataMock.mockImplementation(async (ids) => new Map(ids.map((id) => [id, meta(id)])));
    const second = await evaluateParkedBacklog({ resultsPath, prompt: 'v3' });
    expect(second).toMatchObject({ alreadyEvaluated: 1, recorded: 1, missingMetadata: 0 });
    expect(readRerunResults(resultsPath).map((r) => r.candidateId)).toEqual(['a', 'b']);
  });

  it('does not record model errors, and stops after repeated ones', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) insertCandidate({ id });
    evaluateMock
      .mockResolvedValueOnce(gv('clear_yes', 'Fine', 0.9))
      .mockResolvedValue(gv('uncertain', 'Guard scoring error', 0));

    const report = await evaluateParkedBacklog({ resultsPath, prompt: 'v3' });

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

    const report = await applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3' });

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

    const report = await applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3' });

    expect(report.statusChanged).toBe(2);
    expect(report.otherVersion).toBe(1);
    expect(report.applied.scored).toBe(1);
    expect(candidateRow('moved')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
    expect(candidateRow('still')).toEqual({ status: 'scored', guard_verdict: 'clear_yes' });
  });

  it('refuses without a results file', async () => {
    insertCandidate({ id: 'a' });
    await expect(applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3' })).rejects.toBeInstanceOf(ParkedRerunError);
    expect(existsSync(backupPath)).toBe(false);
    expect(candidateRow('a').status).toBe('guard_pending');
  });

  it('refuses to overwrite an existing backup unless forced', async () => {
    insertCandidate({ id: 'a' });
    writeRerunResults(resultsPath, [result('a', 'clear_no')]);
    writeFileSync(backupPath, 'previous backup');

    await expect(applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3' })).rejects.toBeInstanceOf(ParkedRerunError);
    expect(readFileSync(backupPath, 'utf8')).toBe('previous backup');
    expect(candidateRow('a').status).toBe('guard_pending');

    const report = await applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3', forceBackup: true });
    expect(report.applied.guard_rejected).toBe(1);
    expect(readFileSync(backupPath, 'utf8')).not.toBe('previous backup');
  });

  it('rejects a results file carrying an unknown verdict', async () => {
    insertCandidate({ id: 'a' });
    writeFileSync(resultsPath, JSON.stringify([{ ...result('a', 'clear_yes'), newVerdict: 'approve' }]));
    await expect(applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3' })).rejects.toBeInstanceOf(ParkedRerunError);
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
    ], 'candidate-v3');

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

// ── v4 measurement tooling ───────────────────────────────────────────────────

function rubricVerdict(verdict: CandidateVerdict['verdict'], dims: Partial<RubricScores['dimensions']> = {}): CandidateVerdict {
  const scores: RubricScores = {
    dimensions: {
      language: 0, violence: 0, frightening: 0, sexual: 0,
      substances: 0, dangerous: 0, commercial: 0, attitude: 0, ...dims,
    },
    hardStops: { self_harm: 'none', hate: 'none', child_sexualisation: 'none', manosphere: 'none' },
    flags: { adult_game: false, loot_box: false },
  };
  const decision = verdictFromScores(scores, '13-15', 'discovery');
  return { verdict, reason: 'Synthetic', confidence: 1, promptVersion: 'candidate-v4', rubric: { scores, decision } };
}

describe('sampleCandidates', () => {
  const rows = (kid: string, n: number): { candidate_id: string; user_id: string }[] =>
    Array.from({ length: n }, (_, i) => ({ candidate_id: `${kid}-${String(i).padStart(3, '0')}`, user_id: kid }));

  it('is deterministic for a seed and independent of input order', () => {
    const all = [...rows('k1', 30), ...rows('k2', 30)];
    const a = sampleCandidates(all, 10, 7);
    const b = sampleCandidates([...all].reverse(), 10, 7);
    expect(b).toEqual(a);
    expect(sampleCandidates(all, 10)).toEqual(sampleCandidates(all, 10));
    expect(sampleCandidates(all, 10, 8)).not.toEqual(a);
  });

  it('stratifies evenly by kid', () => {
    const s = sampleCandidates([...rows('k1', 50), ...rows('k2', 10)], 10, 1);
    expect(s.filter((r) => r.user_id === 'k1')).toHaveLength(5);
    expect(s.filter((r) => r.user_id === 'k2')).toHaveLength(5);
  });

  it('gives a short kid’s unused share to the others', () => {
    const s = sampleCandidates([...rows('k1', 50), ...rows('k2', 2)], 10, 1);
    expect(s.filter((r) => r.user_id === 'k2')).toHaveLength(2);
    expect(s.filter((r) => r.user_id === 'k1')).toHaveLength(8);
    expect(new Set(s.map((r) => r.candidate_id)).size).toBe(10);
  });

  it('returns everything when the sample is larger than the population', () => {
    expect(sampleCandidates([...rows('k1', 3), ...rows('k2', 2)], 50, 1)).toHaveLength(5);
  });
});

describe('evaluateParkedBacklog — sampling, populations, concurrency', () => {
  it('--sample evaluates a kid-stratified sample and resumes on the same one', async () => {
    for (let i = 0; i < 12; i++) insertCandidate({ id: `a${i}`, userId: KID_1 });
    for (let i = 0; i < 4; i++) insertCandidate({ id: `b${i}`, userId: KID_2 });
    evaluateMock.mockResolvedValue(gv('uncertain', 'Hm', 0.5));

    const first = await evaluateParkedBacklog({ resultsPath, prompt: 'v3', sample: 6 });
    expect(first).toMatchObject({ eligible: 16, selected: 6, recorded: 6 });
    const users = evaluateMock.mock.calls.map((c) => c[0].userId);
    expect(users.filter((u) => u === KID_1)).toHaveLength(3);
    expect(users.filter((u) => u === KID_2)).toHaveLength(3);

    const second = await evaluateParkedBacklog({ resultsPath, prompt: 'v3', sample: 6 });
    expect(second).toMatchObject({ selected: 6, alreadyEvaluated: 6, recorded: 0 });
    expect(evaluateMock).toHaveBeenCalledTimes(6);
  });

  it('--sample reuses the saved draw after the population changes, and scopes the summary to it', async () => {
    for (let i = 0; i < 12; i++) insertCandidate({ id: `a${i}`, userId: KID_1 });
    for (let i = 0; i < 4; i++) insertCandidate({ id: `b${i}`, userId: KID_2 });
    evaluateMock.mockResolvedValue(gv('uncertain', 'Hm', 0.5));

    const v3 = await evaluateParkedBacklog({ resultsPath, prompt: 'v3', sample: 6 });
    expect(v3).toMatchObject({ sampleReused: false, sampleDropped: 0 });
    const drawn = v3.sampleIds!;
    expect(existsSync(samplesPathFor(resultsPath))).toBe(true);

    // The population moves on: new candidates arrive, one sampled row leaves.
    for (let i = 0; i < 20; i++) insertCandidate({ id: `c${i}`, userId: KID_1 });
    db.prepare(`UPDATE candidate_pool SET status = 'scored' WHERE candidate_id = ?`).run(drawn[0]);
    // A non-sample candidate evaluated at v4 must not leak into the summary.
    await evaluateParkedBacklog({ resultsPath, prompt: 'v4', limit: 1 });
    evaluateMock.mockClear();

    const v4 = await evaluateParkedBacklog({ resultsPath, prompt: 'v4', sample: 6 });
    expect(v4).toMatchObject({ sampleReused: true, sampleDropped: 1, selected: 5 });
    expect(v4.sampleIds).toEqual(drawn);
    const evaluated = evaluateMock.mock.calls.map((c) => c[0].candidateId);
    expect(evaluated.every((id) => drawn.includes(id))).toBe(true);

    const s = summariseRerun(readRerunResults(resultsPath), 'candidate-v4', new Date(), new Set(drawn));
    expect(s.total).toBeLessThanOrEqual(5);
    expect(s.otherVersions).toEqual({ 'candidate-v3': 6 });
  });

  it('passes the chosen prompt to the guard and keys results by its version', async () => {
    insertCandidate({ id: 'a' });
    evaluateMock.mockResolvedValue(rubricVerdict('uncertain', { attitude: 2 }));

    await evaluateParkedBacklog({ resultsPath, prompt: 'v4' });

    expect(evaluateMock.mock.calls[0]![0].prompt).toBe('v4');
    const [entry] = readRerunResults(resultsPath);
    expect(entry).toMatchObject({ promptVersion: 'candidate-v4', drivers: ['over by 1: attitude'] });
    expect(typeof entry!.durationMs).toBe('number');
  });

  it('--population decided samples guard-decided candidates and counts clear_no → clear_yes', async () => {
    insertCandidate({ id: 'yes1', status: 'scored', guardVerdict: 'clear_yes' });
    insertCandidate({ id: 'no1', status: 'guard_rejected', guardVerdict: 'clear_no' });
    insertCandidate({ id: 'no2', status: 'guard_rejected', guardVerdict: 'clear_no' });
    insertCandidate({ id: 'unguarded', status: 'scored', guardVerdict: null });
    insertCandidate({ id: 'parked' });
    insertCandidate({ id: 'adult', userId: PARENT, status: 'scored', guardVerdict: 'clear_yes' });
    evaluateMock.mockImplementation(async (p) =>
      p.candidateId === 'no2' ? rubricVerdict('clear_no', { attitude: 3 }) : rubricVerdict('clear_yes'));

    const report = await evaluateParkedBacklog({ resultsPath, prompt: 'v4', population: 'decided' });

    expect(report).toMatchObject({ population: 'decided', eligible: 3, recorded: 3 });
    expect(evaluateMock.mock.calls.map((c) => c[0].candidateId).sort()).toEqual(['no1', 'no2', 'yes1']);
    const results = readRerunResults(resultsPath);
    expect(results.every((r) => r.population === 'decided')).toBe(true);

    const s = summariseRerun(results, 'candidate-v4');
    expect(s.clearNoToClearYes).toBe(1);
    expect(s.transitions).toEqual({
      'clear_yes -> clear_yes': 1,
      'clear_no -> clear_yes': 1,
      'clear_no -> clear_no': 1,
    });
    expect(s.drivers).toEqual({ 'over by 2+: attitude': 1 });
    // Measurement only: candidate_pool is untouched.
    expect(candidateRow('no1')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
  });

  it('never has more than `concurrency` guard calls in flight', async () => {
    for (let i = 0; i < 10; i++) insertCandidate({ id: `c${i}`, createdAt: daysAgo(20 - i) });
    for (const concurrency of [1, 3, 4]) {
      writeRerunResults(resultsPath, []);
      let inFlight = 0;
      let maxInFlight = 0;
      evaluateMock.mockReset();
      evaluateMock.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return gv('clear_yes', 'Fine', 0.9);
      });
      const report = await evaluateParkedBacklog({ resultsPath, prompt: 'v3', concurrency });
      expect(report.recorded).toBe(10);
      expect(maxInFlight).toBe(concurrency);
      expect(new Set(readRerunResults(resultsPath).map((r) => r.candidateId)).size).toBe(10);
    }
  });

  it('refuses a concurrency outside 1-4', async () => {
    insertCandidate({ id: 'a' });
    await expect(evaluateParkedBacklog({ resultsPath, prompt: 'v3', concurrency: 5 })).rejects.toBeInstanceOf(ParkedRerunError);
    await expect(evaluateParkedBacklog({ resultsPath, prompt: 'v3', concurrency: 0 })).rejects.toBeInstanceOf(ParkedRerunError);
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('reads results files written before the v4 tooling', () => {
    const legacy: Record<string, unknown> = { ...result('a', 'clear_yes') };
    for (const k of ['population', 'durationMs', 'drivers']) delete legacy[k];
    writeFileSync(resultsPath, JSON.stringify([legacy]));
    expect(readRerunResults(resultsPath)).toEqual([{ ...legacy, population: 'pending', durationMs: null, drivers: null }]);
  });
});

describe('applyParkedRerun — prompt version guard', () => {
  beforeEach(() => {
    insertCandidate({ id: 'v3only' });
    insertCandidate({ id: 'v4only' });
    insertCandidate({ id: 'decided', status: 'guard_rejected', guardVerdict: 'clear_no' });
    writeRerunResults(resultsPath, [
      result('v3only', 'clear_no'),
      result('v4only', 'clear_yes', { promptVersion: 'candidate-v4' }),
      result('decided', 'clear_yes', { promptVersion: 'candidate-v4', population: 'decided' }),
    ]);
  });

  it('applies only results at the given version', async () => {
    const report = await applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v3' });
    expect(report).toMatchObject({ promptVersion: 'candidate-v3', otherVersion: 2 });
    expect(report.applied).toEqual({ scored: 0, guard_rejected: 1, guard_pending: 0 });
    expect(candidateRow('v4only').status).toBe('guard_pending');
  });

  it('applies v4 results only when asked for v4, and never decided-population entries', async () => {
    const report = await applyParkedRerun({ resultsPath, backupPath, promptVersion: 'candidate-v4' });
    expect(report.applied).toEqual({ scored: 1, guard_rejected: 0, guard_pending: 0 });
    expect(candidateRow('v4only').status).toBe('scored');
    expect(candidateRow('v3only').status).toBe('guard_pending');
    expect(candidateRow('decided')).toEqual({ status: 'guard_rejected', guard_verdict: 'clear_no' });
  });
});

describe('parseRerunArgs / resolveRerunPrompt', () => {
  it('defaults: evaluate the parked population with the live prompt, one call at a time', () => {
    const args = parseRerunArgs([]);
    expect(args).toEqual({ apply: false, forceBackup: false, population: 'pending', concurrency: 1 });
    expect(resolveRerunPrompt(args, 'v3')).toBe('v3');
    expect(resolveRerunPrompt(args, 'v4')).toBe('v4');
  });

  it('parses the measurement flags', () => {
    expect(parseRerunArgs(['--prompt', 'v4', '--sample', '100', '--seed', '3', '--population', 'decided', '--concurrency', '2']))
      .toEqual({ apply: false, forceBackup: false, prompt: 'v4', sample: 100, seed: 3, population: 'decided', concurrency: 2 });
  });

  it('--apply uses the live prompt unless --prompt is explicit', () => {
    const implicit = parseRerunArgs(['--apply']);
    expect(resolveRerunPrompt(implicit, 'v3')).toBe('v3');
    const explicit = parseRerunArgs(['--apply', '--prompt', 'v4']);
    expect(resolveRerunPrompt(explicit, 'v3')).toBe('v4');
  });

  it.each([
    [['--concurrency', '5']],
    [['--concurrency', '0']],
    [['--prompt', 'v5']],
    [['--population', 'all']],
    [['--sample', '-1']],
    [['--seed', '2']],
    [['--apply', '--sample', '10']],
    [['--apply', '--limit', '10']],
    [['--apply', '--concurrency', '2']],
    [['--apply', '--population', 'decided']],
    [['--force-backup']],
    [['--bogus']],
  ])('rejects %j', (argv) => {
    expect(() => parseRerunArgs(argv)).toThrow(ParkedRerunError);
  });
});
