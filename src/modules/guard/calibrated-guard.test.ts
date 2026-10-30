import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Live calibration on the discovery candidate guard (ADR-0017, amended
// 2026-10-30): with a τ, the v4 rubric call also reads token probabilities,
// and a clear_yes whose probability of a score over the kid's limit is at or
// above τ, or unreadable, becomes uncertain. Real migrations on an in-memory
// DB; Ollama is mocked. All video inputs are synthetic.

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
    GUARD_CANDIDATE_PROMPT: 'v4' as 'v3' | 'v4',
    GUARD_CALIBRATION_TAU: 0.04 as number | null,
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
  ollamaGenerateWithLogprobs: vi.fn(),
}));

vi.mock('../../queue', () => ({
  redis: {},
  guardQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { logger } from '../../logger';
import { ollamaGenerate, ollamaGenerateWithLogprobs, type OllamaLogprobResult, type OllamaTokenLogprob } from '../../ollama';
import {
  AGE_RESTRICTED_REASON,
  CANDIDATE_V4_PROMPT_VERSION,
  DIMENSION_OUTPUT_KEYS,
  GUARD_SCORING_ERROR_REASON,
  RUBRIC_CALL_OPTIONS,
  RUBRIC_SCORES_SCHEMA,
  TOP_LOGPROBS,
  evaluateCandidate,
  evaluateDownloadedPick,
  judgeCandidate,
  type JudgeCandidateInput,
} from './index';

const generate = vi.mocked(ollamaGenerate);
const generateWithLogprobs = vi.mocked(ollamaGenerateWithLogprobs);
const info = vi.mocked(logger.info);
const warn = vi.mocked(logger.warn);

const KID = '11111111-1111-7111-8111-111111111111';
const TITLE = 'Synthetic title';
const CHANNEL = 'Synthetic channel';

type Dist = [number, number, number, number];
// Per output key: the model's distribution over 0–3, or 'unread' for a score
// token whose probabilities can't be used.
type DistSpec = Dist | 'unread';

const SURE_ZERO: Dist = [0.99, 0.01, 0, 0];

// A rubric answer as Ollama streams it with logprobs on: plain tokens for the
// JSON around the scores, and each score digit as one token carrying its
// alternatives. The chosen digit is the most likely one.
function logprobResult(dists: Partial<Record<string, DistSpec>> = {}): OllamaLogprobResult {
  const logprobs: OllamaTokenLogprob[] = [];
  const plain = (token: string) => logprobs.push({ token, logprob: 0 });
  plain('{"');
  plain('reason');
  plain('": "');
  plain('Synthetic reason.');
  plain('",');
  for (const key of Object.values(DIMENSION_OUTPUT_KEYS)) {
    const spec = dists[key] ?? SURE_ZERO;
    plain(` "${key}": `);
    if (spec === 'unread') {
      // No usable probability anywhere at the score's token.
      logprobs.push({ token: '0', logprob: Number.NaN, top_logprobs: [] });
    } else {
      const chosen = spec.indexOf(Math.max(...spec));
      logprobs.push({
        token: String(chosen),
        logprob: Math.log(spec[chosen]!),
        top_logprobs: spec
          .map((p, d) => ({ token: String(d), logprob: Math.log(p) }))
          .filter((a) => Number.isFinite(a.logprob)),
      });
    }
    plain(',');
  }
  plain(' "selfharm": "none", "hate": "none", "childsex": "none", "mano": "none", "game18": false, "lootbox": false}');
  const response = logprobs.map((l) => l.token).join('');
  return { response, logprobs };
}

function input(over: Partial<JudgeCandidateInput> = {}): JudgeCandidateInput {
  return {
    title: TITLE,
    channel: CHANNEL,
    description: 'Synthetic description.',
    tags: ['synthetic'],
    categoryId: '27',
    madeForKids: false,
    // Limits: violence 1, language 2.
    ageBand: '10-12',
    channelHistory: { approved: 3, rejected: 1 },
    prompt: 'v4',
    calibrationTau: 0.04,
    ...over,
  };
}

interface EvalRow {
  prompt_version: string;
  gemma_verdict: string;
  gemma_reason: string;
  rubric_scores_json: string | null;
}

function lastEval(): EvalRow {
  return db.prepare(`
    SELECT prompt_version, gemma_verdict, gemma_reason, rubric_scores_json
    FROM guard_eval ORDER BY rowid DESC LIMIT 1
  `).get() as EvalRow;
}

beforeAll(() => {
  runMigrations();
  db.prepare('INSERT INTO users (user_id, display_name, role, age_gate, birth_year, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(KID, 'Boy1', 'kid', 12, new Date().getUTCFullYear() - 11, new Date().toISOString());
});

beforeEach(() => {
  mockConfig.GUARD_CANDIDATE_PROMPT = 'v4';
  mockConfig.GUARD_CALIBRATION_TAU = 0.04;
  generate.mockReset();
  generateWithLogprobs.mockReset();
  info.mockClear();
  warn.mockClear();
  db.exec('DELETE FROM guard_eval');
});

describe('judgeCandidate with calibration', () => {
  it('makes the plain rubric call with logprobs on: same prompt, model, options and schema', async () => {
    generate.mockResolvedValue(logprobResult().response);
    await judgeCandidate(input({ calibrationTau: null }));
    generateWithLogprobs.mockResolvedValue(logprobResult());
    await judgeCandidate(input());

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateWithLogprobs).toHaveBeenCalledTimes(1);
    const [prompt, model, options, schema, top] = generateWithLogprobs.mock.calls[0]!;
    expect(prompt).toBe(generate.mock.calls[0]![0]);
    expect(model).toBe('gemma4:e4b');
    expect(options).toEqual(RUBRIC_CALL_OPTIONS);
    expect(schema).toBe(RUBRIC_SCORES_SCHEMA);
    expect(top).toBe(TOP_LOGPROBS);
  });

  it('keeps a clear_yes whose p_over is below τ, reason unchanged', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0.9, 0.08, 0.015, 0.005] }));
    const v = await judgeCandidate(input());
    expect(v.verdict).toBe('clear_yes');
    expect(v.reason).toBe('Synthetic reason.');
    expect(v.promptVersion).toBe(CANDIDATE_V4_PROMPT_VERSION);
    expect(v.rubric?.calibration?.tau).toBe(0.04);
    expect(v.rubric?.calibration?.pOver).toBeCloseTo(0.02, 10);
    expect(v.rubric?.calibration?.dimension).toBe('violence');
    expect(info).not.toHaveBeenCalled();
  });

  it('escalates a clear_yes whose p_over is above τ, naming the driver', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0.85, 0.08, 0.05, 0.02] }));
    const v = await judgeCandidate(input());
    expect(v.verdict).toBe('uncertain');
    expect(v.reason).toBe('Synthetic reason. (Violence: 7% chance over the limit, escalates at 4%)');
    // The plain decision is kept beside it.
    expect(v.rubric?.decision.verdict).toBe('clear_yes');
    expect(v.rubric?.calibration).toMatchObject({ tau: 0.04, dimension: 'violence' });
  });

  it('escalates at exactly τ', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ lang: [0.5, 0.3, 0.15, 0.05] }));
    const probe = await judgeCandidate(input({ calibrationTau: 1 }));
    const p = probe.rubric!.calibration!.pOver!;
    expect(probe.verdict).toBe('clear_yes');
    expect(probe.rubric?.calibration?.dimension).toBe('language');

    const atTau = await judgeCandidate(input({ calibrationTau: p }));
    expect(atTau.verdict).toBe('uncertain');
    expect(atTau.reason).toContain('Language: 5% chance over the limit');
  });

  it('logs an escalation at info with numbers and the dimension only', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0.85, 0.08, 0.05, 0.02] }));
    await judgeCandidate(input());
    expect(info).toHaveBeenCalledTimes(1);
    const [fields] = info.mock.calls[0]! as unknown as [Record<string, unknown>, string];
    expect(Object.keys(fields).sort()).toEqual(['dimension', 'pOver', 'tau']);
    expect(fields).toMatchObject({ tau: 0.04, dimension: 'violence' });
    expect(JSON.stringify(info.mock.calls)).not.toContain(TITLE);
    expect(JSON.stringify(info.mock.calls)).not.toContain(CHANNEL);
  });

  it('escalates a clear_yes with one dimension unread, and warns', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ att: 'unread' }));
    const v = await judgeCandidate(input());
    expect(v.verdict).toBe('uncertain');
    expect(v.reason).toBe('Synthetic reason. (Score probabilities unreadable: escalated)');
    expect(v.rubric?.calibration).toEqual({ tau: 0.04, pOver: null, dimension: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ unread: ['attitude'], escalated: true });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TITLE);
  });

  it('escalates when the tokens do not rebuild the answer (every dimension unread)', async () => {
    const { response } = logprobResult();
    generateWithLogprobs.mockResolvedValue({ response, logprobs: [] });
    const v = await judgeCandidate(input());
    expect(v.verdict).toBe('uncertain');
    expect(v.rubric?.calibration?.pOver).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never changes a clear_no', async () => {
    // Violence 3 against a limit of 1: clear_no by rule.
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0, 0, 0.1, 0.9], att: 'unread' }));
    const v = await judgeCandidate(input());
    expect(v.verdict).toBe('clear_no');
    expect(v.reason).toBe('Synthetic reason. (Violence 3 (limit 1))');
  });

  it('never changes an uncertain', async () => {
    // Violence 2 against a limit of 1: uncertain by rule.
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0, 0.1, 0.8, 0.1] }));
    const v = await judgeCandidate(input());
    expect(v.verdict).toBe('uncertain');
    expect(v.reason).toBe('Synthetic reason. (Violence 2 (limit 1))');
    expect(info).not.toHaveBeenCalled();
  });

  it('reads p_over against the kid’s own limits band', async () => {
    // Violence 2 is over the 10-12 limit (1) but within 13-15's (2).
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0.7, 0.2, 0.09, 0.01] }));
    const younger = await judgeCandidate(input({ ageBand: '10-12' }));
    const older = await judgeCandidate(input({ ageBand: '13-15' }));
    expect(younger.verdict).toBe('uncertain');
    expect(older.verdict).toBe('clear_yes');
    expect(older.rubric?.calibration?.pOver).toBeCloseTo(0.01, 10);
  });

  it('a failed call is uncertain with the scoring-error reason, as today', async () => {
    generateWithLogprobs.mockRejectedValue(new Error('down'));
    const v = await judgeCandidate(input());
    expect(v).toMatchObject({ verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON, rubric: null });
  });

  it('an unparsable answer is uncertain with the scoring-error reason, as today', async () => {
    generateWithLogprobs.mockResolvedValue({ response: 'not json', logprobs: [{ token: 'not json', logprob: 0 }] });
    const v = await judgeCandidate(input());
    expect(v).toMatchObject({ verdict: 'uncertain', reason: GUARD_SCORING_ERROR_REASON, rubric: null });
  });

  it('calibrationTau null: the plain call, no logprobs, today’s verdict', async () => {
    generate.mockResolvedValue(logprobResult({ viol: [0.5, 0.1, 0.2, 0.2] }).response);
    const v = await judgeCandidate(input({ calibrationTau: null }));
    expect(generateWithLogprobs).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(v.verdict).toBe('clear_yes');
    expect(v.reason).toBe('Synthetic reason.');
    expect(v.rubric).not.toHaveProperty('calibration');
  });

  it('age-restricted: clear_no by rule with no call at all', async () => {
    const v = await judgeCandidate(input({ ageRestricted: true }));
    expect(v).toMatchObject({ verdict: 'clear_no', reason: AGE_RESTRICTED_REASON, rubric: null });
    expect(generate).not.toHaveBeenCalled();
    expect(generateWithLogprobs).not.toHaveBeenCalled();
  });

  it('v3: the verdict prompt, never calibrated', async () => {
    generate.mockResolvedValue('{"reason":"Fine.","verdict":"clear_yes","confidence":0.8}');
    const v = await judgeCandidate(input({ prompt: 'v3' }));
    expect(v.verdict).toBe('clear_yes');
    expect(generateWithLogprobs).not.toHaveBeenCalled();
  });
});

describe('evaluateCandidate records calibration', () => {
  const candidate = (over: Partial<Parameters<typeof evaluateCandidate>[0]> = {}) => ({
    candidateId: 'cand-1',
    userId: KID,
    url: 'https://example.invalid/1',
    title: TITLE,
    channel: CHANNEL,
    ...over,
  });

  it('passes GUARD_CALIBRATION_TAU and writes the calibration field', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ viol: [0.85, 0.08, 0.05, 0.02] }));
    const v = await evaluateCandidate(candidate());
    expect(v.verdict).toBe('uncertain');

    const row = lastEval();
    expect(row.prompt_version).toBe(CANDIDATE_V4_PROMPT_VERSION);
    expect(row.gemma_verdict).toBe('uncertain');
    expect(row.gemma_reason).toContain('Violence: 7% chance over the limit, escalates at 4%');
    const stored = JSON.parse(row.rubric_scores_json!) as Record<string, unknown>;
    expect(stored['calibration']).toMatchObject({ tau: 0.04, dimension: 'violence' });
    expect((stored['calibration'] as { pOver: number }).pOver).toBeCloseTo(0.07, 10);
    // The rest of the record is as before.
    expect(stored).toHaveProperty('dimensions');
    expect(stored['drivers']).toEqual([]);
  });

  it('records pOver and dimension as null when unread', async () => {
    generateWithLogprobs.mockResolvedValue(logprobResult({ comm: 'unread' }));
    await evaluateCandidate(candidate());
    const stored = JSON.parse(lastEval().rubric_scores_json!) as Record<string, unknown>;
    expect(stored['calibration']).toEqual({ tau: 0.04, pOver: null, dimension: null });
  });

  it('omits the field when calibration is off', async () => {
    mockConfig.GUARD_CALIBRATION_TAU = null;
    generate.mockResolvedValue(logprobResult().response);
    await evaluateCandidate(candidate());
    expect(generateWithLogprobs).not.toHaveBeenCalled();
    const stored = JSON.parse(lastEval().rubric_scores_json!) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('calibration');
  });

  it('omits the field when the call failed', async () => {
    generateWithLogprobs.mockRejectedValue(new Error('down'));
    await evaluateCandidate(candidate());
    expect(lastEval()).toMatchObject({ gemma_verdict: 'uncertain', rubric_scores_json: null });
  });
});

describe('the second pass is not calibrated', () => {
  it('makes the plain rubric call even with a τ configured', async () => {
    db.exec('PRAGMA foreign_keys = OFF');
    generate.mockResolvedValue(logprobResult().response);
    const v = await evaluateDownloadedPick({
      requestId: 'req-1',
      userId: KID,
      url: 'https://example.invalid/2',
      title: TITLE,
      channel: null,
      description: 'Synthetic yt-dlp description.',
      transcript: 'Synthetic transcript words.',
      metadata: null,
    });
    db.exec('PRAGMA foreign_keys = ON');
    expect(v.verdict).toBe('clear_yes');
    expect(generateWithLogprobs).not.toHaveBeenCalled();
    expect(JSON.parse(lastEval().rubric_scores_json!)).not.toHaveProperty('calibration');
  });
});
