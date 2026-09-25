import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// candidate-v4 (Phase 6a) end to end inside the guard: the prompt switch, the
// static prompt prefix, rubric scoring → verdictFromScores, and the
// guard_eval rubric columns. Real migrations on an in-memory DB; Ollama is
// mocked. All video inputs are synthetic.

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
    GUARD_CANDIDATE_PROMPT: 'v3' as 'v3' | 'v4',
  },
}));

vi.mock('../../config', () => ({ config: mockConfig }));

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

vi.mock('../../queue', () => ({
  redis: {},
  guardQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { ollamaGenerate } from '../../ollama';
import {
  CANDIDATE_PROMPT_VERSION,
  CANDIDATE_V4_PROMPT_VERSION,
  GUARD_SCORING_ERROR_REASON,
  RUBRIC_PROMPT_PREFIX,
  RUBRIC_VERSION,
  SECOND_PASS_PROMPT_VERSION,
  SECOND_PASS_V4_NO_TRANSCRIPT_PROMPT_VERSION,
  SECOND_PASS_V4_PROMPT_VERSION,
  evaluateCandidate,
  evaluateDownloadedPick,
  liveCandidatePrompt,
} from './index';

const generate = vi.mocked(ollamaGenerate);

const KID_OLDER = '11111111-1111-7111-8111-111111111111';
const KID_YOUNGER = '22222222-2222-7222-8222-222222222222';
const THIS_YEAR = new Date().getUTCFullYear();

interface EvalRow {
  prompt_version: string;
  gemma_verdict: string;
  gemma_reason: string;
  gemma_confidence: number | null;
  rubric_version: string | null;
  rubric_scores_json: string | null;
}

function lastEval(): EvalRow {
  return db.prepare(`
    SELECT prompt_version, gemma_verdict, gemma_reason, gemma_confidence, rubric_version, rubric_scores_json
    FROM guard_eval ORDER BY rowid DESC LIMIT 1
  `).get() as EvalRow;
}

// Compact-key model output (see rubric-prompt.ts).
function modelOutput(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reason: 'Synthetic reason.',
    lang: 0, viol: 0, fear: 0, sex: 0, subs: 0, risk: 0, comm: 0, att: 0,
    selfharm: 'none', hate: 'none', childsex: 'none', mano: 'none',
    game18: false, lootbox: false,
    ...over,
  });
}

function candidate(over: Partial<Parameters<typeof evaluateCandidate>[0]> = {}): Parameters<typeof evaluateCandidate>[0] {
  return {
    candidateId: 'cand-1',
    userId: KID_OLDER,
    url: 'https://www.youtube.com/watch?v=synthetic1',
    title: 'Synthetic title one',
    channel: 'Synthetic channel',
    description: 'Synthetic description.',
    tags: ['synthetic'],
    categoryId: '27',
    madeForKids: false,
    ...over,
  };
}

beforeAll(() => {
  runMigrations();
  const insert = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  insert.run(KID_OLDER, 'Boy1', 'kid', 12, THIS_YEAR - 13, now);
  insert.run(KID_YOUNGER, 'Boy2', 'kid', 10, THIS_YEAR - 9, now);
});

beforeEach(() => {
  mockConfig.GUARD_CANDIDATE_PROMPT = 'v3';
  generate.mockReset();
  db.exec('DELETE FROM guard_eval');
});

describe('migration 043', () => {
  it('adds nullable rubric_version and rubric_scores_json to guard_eval', () => {
    const cols = db.prepare('PRAGMA table_info(guard_eval)').all() as { name: string; notnull: number }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('rubric_version')?.notnull).toBe(0);
    expect(byName.get('rubric_scores_json')?.notnull).toBe(0);
  });
});

describe('GUARD_CANDIDATE_PROMPT switch', () => {
  it('defaults to v3: the verdict prompt, with the rubric columns left null', async () => {
    expect(liveCandidatePrompt()).toBe('v3');
    generate.mockResolvedValue('{"reason":"Fine.","verdict":"clear_yes","confidence":0.9}');

    const v = await evaluateCandidate(candidate());

    expect(v).toMatchObject({ verdict: 'clear_yes', promptVersion: CANDIDATE_PROMPT_VERSION, rubric: null });
    const [prompt, , , , schema] = generate.mock.calls[0]!;
    expect(prompt.startsWith(RUBRIC_PROMPT_PREFIX)).toBe(false);
    expect((schema as { properties: Record<string, unknown> }).properties).toHaveProperty('verdict');
    expect(lastEval()).toMatchObject({
      prompt_version: CANDIDATE_PROMPT_VERSION,
      gemma_confidence: 0.9,
      rubric_version: null,
      rubric_scores_json: null,
    });
  });

  it('v4 scores the rubric and records the scores and drivers', async () => {
    mockConfig.GUARD_CANDIDATE_PROMPT = 'v4';
    expect(liveCandidatePrompt()).toBe('v4');
    generate.mockResolvedValue(modelOutput({ att: 2 }));

    const v = await evaluateCandidate(candidate());

    expect(v.verdict).toBe('uncertain');
    expect(v.promptVersion).toBe(CANDIDATE_V4_PROMPT_VERSION);
    expect(v.rubric?.decision.drivers).toEqual([
      { kind: 'dimension', key: 'attitude', score: 2, limit: 1, over: 1, outcome: 'uncertain' },
    ]);
    expect(v.reason).toBe('Synthetic reason. (Attitude 2 (limit 1))');
    const [prompt, , , options, schema] = generate.mock.calls[0]!;
    expect(prompt.startsWith(RUBRIC_PROMPT_PREFIX)).toBe(true);
    expect((schema as { properties: Record<string, unknown> }).properties).toHaveProperty('att');
    expect(options).toMatchObject({ temperature: 0, think: false });

    const row = lastEval();
    expect(row).toMatchObject({
      prompt_version: CANDIDATE_V4_PROMPT_VERSION,
      gemma_verdict: 'uncertain',
      gemma_confidence: null,
      rubric_version: RUBRIC_VERSION,
    });
    const stored = JSON.parse(row.rubric_scores_json!) as Record<string, unknown>;
    expect(stored).toMatchObject({
      dimensions: { attitude: 2, language: 0 },
      hardStops: { hate: 'none' },
      flags: { adult_game: false, loot_box: false },
      limitsBand: '13-15',
      context: 'discovery',
    });
    expect(stored['drivers']).toHaveLength(1);
  });

  it('an explicit prompt overrides the live one (the parked re-run)', async () => {
    generate.mockResolvedValue(modelOutput());
    const v = await evaluateCandidate(candidate({ prompt: 'v4' }));
    expect(v).toMatchObject({ verdict: 'clear_yes', promptVersion: CANDIDATE_V4_PROMPT_VERSION });
    expect(lastEval().prompt_version).toBe(CANDIDATE_V4_PROMPT_VERSION);
  });
});

describe('candidate-v4 verdicts', () => {
  beforeEach(() => {
    mockConfig.GUARD_CANDIDATE_PROMPT = 'v4';
  });

  it('decides by the kid’s band: the same scores clear one kid and not the other', async () => {
    generate.mockResolvedValue(modelOutput({ fear: 2 }));
    const older = await evaluateCandidate(candidate({ userId: KID_OLDER }));
    const younger = await evaluateCandidate(candidate({ userId: KID_YOUNGER }));
    expect(older.verdict).toBe('clear_yes');
    expect(younger.verdict).toBe('uncertain');
  });

  it('a flagged candidate is never surfaced, and the reason names the flag', async () => {
    generate.mockResolvedValue(modelOutput({ lootbox: true, comm: 2 }));
    const v = await evaluateCandidate(candidate());
    expect(v.verdict).toBe('clear_no');
    expect(v.reason).toContain('Loot-box / pack opening: never surfaced by discovery');
  });

  it('age-restricted stays a clear_no with no model call', async () => {
    const v = await evaluateCandidate(candidate({ ageRestricted: true }));
    expect(v).toMatchObject({ verdict: 'clear_no', promptVersion: CANDIDATE_V4_PROMPT_VERSION, rubric: null });
    expect(generate).not.toHaveBeenCalled();
    expect(lastEval()).toMatchObject({ prompt_version: CANDIDATE_V4_PROMPT_VERSION, rubric_version: null });
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['a missing key', JSON.stringify({ reason: 'x', lang: 0 })],
    ['a score out of range', modelOutput({ viol: 4 })],
    ['an unknown hard-stop level', modelOutput({ hate: 'maybe' })],
    ['a non-boolean flag', modelOutput({ game18: 'no' })],
  ])('%s is a scoring error → uncertain, never a pass', async (_label, raw) => {
    generate.mockResolvedValue(raw);
    const v = await evaluateCandidate(candidate());
    expect(v).toMatchObject({ verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON, confidence: 0, rubric: null });
    expect(lastEval()).toMatchObject({ rubric_version: RUBRIC_VERSION, rubric_scores_json: null });
  });

  it('a model call that throws is uncertain', async () => {
    generate.mockRejectedValue(new Error('Ollama down'));
    const v = await evaluateCandidate(candidate());
    expect(v).toMatchObject({ verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON });
  });
});

describe('static-first prompt layout', () => {
  beforeEach(() => {
    mockConfig.GUARD_CANDIDATE_PROMPT = 'v4';
    generate.mockResolvedValue(modelOutput());
  });

  it('the prefix is byte-identical for different candidates and age bands; video details come after it', async () => {
    await evaluateCandidate(candidate({ userId: KID_OLDER }));
    await evaluateCandidate(candidate({
      candidateId: 'cand-2',
      userId: KID_YOUNGER,
      url: 'https://www.youtube.com/watch?v=synthetic2',
      title: 'A completely different synthetic title',
      channel: 'Another synthetic channel',
      description: 'Other words.',
      tags: ['other'],
      categoryId: '20',
      madeForKids: true,
    }));
    const [a, b] = generate.mock.calls.map((c) => c[0]);
    const prefixA = a!.slice(0, RUBRIC_PROMPT_PREFIX.length);
    const prefixB = b!.slice(0, RUBRIC_PROMPT_PREFIX.length);
    expect(prefixA).toBe(RUBRIC_PROMPT_PREFIX);
    expect(prefixB).toBe(RUBRIC_PROMPT_PREFIX);
    expect(a!.slice(RUBRIC_PROMPT_PREFIX.length)).toContain('Title: Synthetic title one');
    expect(b!.slice(RUBRIC_PROMPT_PREFIX.length)).toContain('Title: A completely different synthetic title');
  });

  it('carries no age band, date or id anywhere in the prefix', () => {
    for (const band of ['under 10', '10-12', '13-15', '16-17', '18+']) {
      expect(RUBRIC_PROMPT_PREFIX).not.toContain(band);
    }
    expect(RUBRIC_PROMPT_PREFIX).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(RUBRIC_PROMPT_PREFIX).not.toContain('synthetic');
  });

  it('keeps the age band out of the prompt entirely (scored band-independently)', async () => {
    await evaluateCandidate(candidate({ ageBand: '10-12' }));
    expect(generate.mock.calls[0]![0]).not.toContain('10-12');
  });
});

describe('download-time second pass under v4', () => {
  const pick = {
    requestId: 'req-1',
    userId: KID_OLDER,
    url: 'https://www.youtube.com/watch?v=synthetic3',
    title: 'Synthetic pick',
    channel: null,
    description: 'Synthetic yt-dlp description.',
    transcript: 'Synthetic transcript words.',
    metadata: null,
  };

  beforeEach(() => {
    db.exec('PRAGMA foreign_keys = OFF');
  });

  it('uses candidate-transcript-v4 with the same prefix and the transcript last', async () => {
    mockConfig.GUARD_CANDIDATE_PROMPT = 'v4';
    generate.mockResolvedValue(modelOutput());
    const v = await evaluateDownloadedPick(pick);
    expect(v).toMatchObject({ verdict: 'clear_yes', transcriptAvailable: true });
    const prompt = generate.mock.calls[0]![0];
    expect(prompt.startsWith(RUBRIC_PROMPT_PREFIX)).toBe(true);
    expect(prompt.trimEnd().endsWith('Synthetic transcript words.')).toBe(true);
    expect(lastEval()).toMatchObject({ prompt_version: SECOND_PASS_V4_PROMPT_VERSION, rubric_version: RUBRIC_VERSION });
  });

  it('records the no-transcript v4 variant when captions are missing', async () => {
    mockConfig.GUARD_CANDIDATE_PROMPT = 'v4';
    generate.mockResolvedValue(modelOutput({ game18: true }));
    const v = await evaluateDownloadedPick({ ...pick, transcript: null });
    // A slate pick is a discovery surface: a flag never shows.
    expect(v).toMatchObject({ verdict: 'clear_no', transcriptAvailable: false });
    expect(lastEval().prompt_version).toBe(SECOND_PASS_V4_NO_TRANSCRIPT_PROMPT_VERSION);
  });

  it('stays on candidate-transcript-v1 while v3 is live', async () => {
    generate.mockResolvedValue('{"reason":"Fine.","verdict":"clear_yes","confidence":0.9}');
    await evaluateDownloadedPick(pick);
    expect(lastEval()).toMatchObject({ prompt_version: SECOND_PASS_PROMPT_VERSION, rubric_version: null });
  });
});
