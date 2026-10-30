import { describe, expect, it, vi } from 'vitest';

// The logprob adapter against a recorded response, with the real rubric and
// prompt and a stubbed Ollama call: it sends what the incumbent sends, decides
// as the incumbent decides, and stores a distribution per dimension.

vi.mock('../../db/client', () => {
  throw new Error('the logprob adapter must not open the DB');
});

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b', NODE_ENV: 'test' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { OllamaLogprobResult } from '../../ollama';
import { DIMENSION_KEYS, RUBRIC_VERSION, verdictFromScores } from '../guard/rubric';
import {
  CANDIDATE_V4_PROMPT_VERSION,
  DIMENSION_OUTPUT_KEYS,
  RUBRIC_SCORES_SCHEMA,
  buildRubricPrompt,
  parseRubricOutput,
} from '../guard/rubric-prompt';
import { TOP_LOGPROBS } from '../guard/calibration';
import { RECORDED_RESPONSE } from '../guard/logprob-fixture';
import { gemmaLogprobAdapter, type LogprobGuard } from './adapters';
import { AdapterScoringError, type HarnessItem } from './util';

const RUBRIC_CALL_OPTIONS = { temperature: 0, num_predict: 256, think: false, keep_alive: '30m', truncate: false, shift: false };

// The guard module's pieces, without loading the guard (and its DB).
const guard: LogprobGuard = {
  DIMENSION_OUTPUT_KEYS,
  RUBRIC_CALL_OPTIONS,
  RUBRIC_SCORES_SCHEMA,
  buildRubricPrompt,
  candidateRubricInput: (input) => ({
    title: input.title,
    channel: input.channel?.trim() ?? '',
    description: input.description ?? '',
    tags: input.tags ?? [],
    category: null,
    madeForKids: input.madeForKids ?? null,
    channelHistory: input.channelHistory,
    transcript: null,
  }),
  parseRubricOutput,
  rerunVersionKey: (prompt) => (prompt === 'v4' ? `${CANDIDATE_V4_PROMPT_VERSION}+${RUBRIC_VERSION}` : 'candidate-v3'),
  verdictFromScores,
};

function item(ageBand: string, ageRestricted = false): HarnessItem {
  return {
    itemId: 'd1', subjectType: 'candidate', subjectId: 'c-d1', userId: 'kid_1', label: 'clear_yes',
    firstPassLabel: 'clear_yes', revisedAt: null, blockKind: null, decisionSource: 'spot_check', rubricVersion: 'rubric-v1.3',
    guardVerdict: 'clear_yes', livePromptVersion: null, inputs: 'original',
    decidedAt: '2026-09-20T12:00:00.000Z', holdout: false, ageBand,
    title: 'Placeholder title', channel: ' Placeholder channel ', description: 'Placeholder description', tags: ['a'],
    categoryId: null, madeForKids: false, ageRestricted, channelHistory: null,
  };
}

describe('gemmaLogprobAdapter', () => {
  it('has its own id carrying the model, prompt and rubric versions', () => {
    const adapter = gemmaLogprobAdapter(guard, vi.fn());
    expect(adapter.id).toBe(`gemma:gemma4:e4b:${CANDIDATE_V4_PROMPT_VERSION}+${RUBRIC_VERSION}+logprob-v1`);
    expect(adapter.id).not.toBe(`gemma:gemma4:e4b:${CANDIDATE_V4_PROMPT_VERSION}+${RUBRIC_VERSION}`);
  });

  it("sends the incumbent's prompt, model, options and schema, asking for logprobs", async () => {
    const generate = vi.fn(async (): Promise<OllamaLogprobResult> => RECORDED_RESPONSE);
    await gemmaLogprobAdapter(guard, generate).judge(item('10-12'));
    expect(generate).toHaveBeenCalledWith(
      buildRubricPrompt(guard.candidateRubricInput({ ...item('10-12'), prompt: 'v4' })),
      'gemma4:e4b',
      RUBRIC_CALL_OPTIONS,
      RUBRIC_SCORES_SCHEMA,
      TOP_LOGPROBS,
    );
  });

  it("decides as verdictFromScores on the decoded scores, with every dimension's distribution", async () => {
    const generate = vi.fn(async (): Promise<OllamaLogprobResult> => RECORDED_RESPONSE);
    const parsed = parseRubricOutput(RECORDED_RESPONSE.response)!;
    for (const band of ['under 10', '10-12', '13-15']) {
      const j = await gemmaLogprobAdapter(guard, generate).judge(item(band));
      expect(j.verdict).toBe(verdictFromScores(parsed.scores, band, 'discovery').verdict);
      expect(j.scores).toEqual(parsed.scores.dimensions);
      expect(Object.keys(j.distributions!).sort()).toEqual([...DIMENSION_KEYS].sort());
      for (const k of DIMENSION_KEYS) expect(j.distributions![k], k).not.toBeNull();
    }
  });

  it('is clear_no with no model call for an age-restricted video, as judgeCandidate', async () => {
    const generate = vi.fn();
    expect(await gemmaLogprobAdapter(guard, generate).judge(item('10-12', true))).toEqual({ verdict: 'clear_no' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('throws a scoring error (retried, not cached) when the call fails or the scores do not parse', async () => {
    const failing = vi.fn(async (): Promise<OllamaLogprobResult> => {
      throw new Error('Ollama unreachable');
    });
    await expect(gemmaLogprobAdapter(guard, failing).judge(item('10-12'))).rejects.toBeInstanceOf(AdapterScoringError);
    const partial = vi.fn(async (): Promise<OllamaLogprobResult> => ({ response: '{"reason": "x", "lang": 0}', logprobs: [] }));
    await expect(gemmaLogprobAdapter(guard, partial).judge(item('10-12'))).rejects.toBeInstanceOf(AdapterScoringError);
  });
});
