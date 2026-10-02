import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// judgeCandidate: the side-effect-free candidate judge the guard harness
// replays decisions through. Real migrations on an in-memory DB; Ollama is
// mocked. All video inputs are synthetic.

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b', GUARD_CANDIDATE_PROMPT: 'v3' },
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
  AGE_RESTRICTED_REASON,
  CANDIDATE_PROMPT_VERSION,
  CANDIDATE_V4_PROMPT_VERSION,
  GUARD_SCORING_ERROR_REASON,
  evaluateCandidate,
  judgeCandidate,
  type JudgeCandidateInput,
} from './index';

const generate = vi.mocked(ollamaGenerate);
const KID = '11111111-1111-7111-8111-111111111111';

function modelOutput(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reason: 'Synthetic reason.',
    lang: 0, viol: 0, fear: 0, sex: 0, subs: 0, risk: 0, comm: 0, att: 0,
    selfharm: 'none', hate: 'none', childsex: 'none', mano: 'none',
    game18: false, lootbox: false,
    ...over,
  });
}

function input(over: Partial<JudgeCandidateInput> = {}): JudgeCandidateInput {
  return {
    title: 'Synthetic title',
    channel: 'Synthetic channel',
    description: 'Synthetic description.',
    tags: ['synthetic'],
    categoryId: '27',
    madeForKids: false,
    ageBand: '10-12',
    channelHistory: { approved: 3, rejected: 1 },
    prompt: 'v4',
    ...over,
  };
}

// Rows changed on the connection since it opened: any write moves it.
const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
const evalRows = () => (db.prepare('SELECT COUNT(*) AS n FROM guard_eval').get() as { n: number }).n;

beforeAll(() => {
  runMigrations();
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(KID, 'Boy1', 'kid', 12, new Date().getUTCFullYear() - 11, new Date().toISOString());
});

beforeEach(() => {
  generate.mockReset();
  db.exec('DELETE FROM guard_eval');
});

describe('judgeCandidate', () => {
  it('v4: returns the verdict and rubric scores and writes nothing', async () => {
    generate.mockResolvedValue(modelOutput({ viol: 3 }));
    const before = changes();

    const v = await judgeCandidate(input());

    expect(v.verdict).toBe('clear_no');
    expect(v.promptVersion).toBe(CANDIDATE_V4_PROMPT_VERSION);
    expect(v.rubric?.scores.dimensions.violence).toBe(3);
    expect(changes()).toBe(before);
    expect(evalRows()).toBe(0);
  });

  it('uses the channel history it is given, not the DB', async () => {
    generate.mockResolvedValue(modelOutput());
    await judgeCandidate(input({ channelHistory: { approved: 7, rejected: 2 } }));
    expect(generate.mock.calls[0]![0]).toContain('7 previously approved, 2 previously rejected');
  });

  it('v4 model failure: uncertain with the scoring-error reason, nothing written', async () => {
    generate.mockRejectedValue(new Error('down'));
    const before = changes();
    const v = await judgeCandidate(input());
    expect(v).toMatchObject({ verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON, rubric: null });
    expect(changes()).toBe(before);
  });

  it('v3: the verdict prompt, nothing written', async () => {
    generate.mockResolvedValue('{"reason":"Fine.","verdict":"clear_yes","confidence":0.8}');
    const before = changes();
    const v = await judgeCandidate(input({ prompt: 'v3' }));
    expect(v).toMatchObject({ verdict: 'clear_yes', confidence: 0.8, promptVersion: CANDIDATE_PROMPT_VERSION, rubric: null });
    expect(changes()).toBe(before);
  });

  it('age-restricted: clear_no by rule, no model call, nothing written', async () => {
    const before = changes();
    const v = await judgeCandidate(input({ ageRestricted: true }));
    expect(v).toMatchObject({ verdict: 'clear_no', reason: AGE_RESTRICTED_REASON });
    expect(generate).not.toHaveBeenCalled();
    expect(changes()).toBe(before);
  });
});

describe('evaluateCandidate still records what it judged', () => {
  it('writes one guard_eval row per call', async () => {
    generate.mockResolvedValue(modelOutput());
    await evaluateCandidate({ candidateId: 'cand-1', userId: KID, url: 'https://example.invalid/1', title: 'Synthetic', prompt: 'v4' });
    generate.mockRejectedValue(new Error('down'));
    await evaluateCandidate({ candidateId: 'cand-2', userId: KID, url: 'https://example.invalid/2', title: 'Synthetic', prompt: 'v4' });
    expect(evalRows()).toBe(2);
  });
});
