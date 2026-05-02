import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scoreForRequest, evaluateCandidate, evaluateKidInterest } from './index';

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

// Stub the queue module — guard.ts imports `redis` at module load so the
// guardWorker constructor can use it. Tests never start the worker; this
// just keeps the import graph satisfied.
vi.mock('../../queue', () => ({
  redis: {},
  guardQueue: { add: vi.fn() },
}));

// Routed by SQL substring so the prior-eval lookup returns undefined (fresh
// scoring path) while the channel-history lookup still returns a row. The
// `.run()` calls for every prepare are captured on `mockRun` so tests can
// inspect insert/update args. Tests can override `priorEval` to exercise the
// cached path or `channelHistory` to drive prompt-content assertions.
let priorEval: { gemma_verdict: string; gemma_reason: string; gemma_confidence: number } | undefined;
let channelHistory: { approved: number; rejected: number } = { approved: 0, rejected: 0 };
let interestRow: { search_terms: string } | undefined;
const mockRun = vi.fn();

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM guard_eval')) return priorEval;
        if (sql.includes('FROM requests')) return channelHistory;
        if (sql.includes('FROM interests')) return interestRow;
        return undefined;
      }),
      run: mockRun,
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';

beforeEach(() => {
  priorEval = undefined;
  channelHistory = { approved: 0, rejected: 0 };
  interestRow = undefined;
  mockRun.mockReset();
  vi.mocked(ollamaGenerate).mockReset();
});

describe('scoreForRequest verdict parsing', () => {
  it('parses a clean JSON response', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '{"verdict":"clear_yes","reason":"Educational coding content.","confidence":0.9}'
    );
    const result = await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 't', channel: 'c', description: 'd', transcript: null,
    });
    expect(result.verdict).toBe('clear_yes');
    expect(result.reason).toBe('Educational coding content.');
    expect(result.confidence).toBe(0.9);
  });

  it('extracts JSON embedded in preamble text', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      'Sure, here is my assessment:\n{"verdict":"uncertain","reason":"Ambiguous content.","confidence":0.5}\nDone.'
    );
    const result = await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 't', channel: 'c', description: 'd', transcript: null,
    });
    expect(result.verdict).toBe('uncertain');
  });

  it('clamps confidence to 0–1', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '{"verdict":"clear_no","reason":"Violence.","confidence":1.5}'
    );
    const result = await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 't', channel: 'c', description: 'd', transcript: null,
    });
    expect(result.confidence).toBe(1);
  });

  it('defaults to uncertain on missing JSON', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('no json here');
    const result = await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 't', channel: 'c', description: 'd', transcript: null,
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });

  it('defaults to uncertain on invalid verdict value', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"maybe","reason":"x","confidence":0.5}');
    const result = await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 't', channel: 'c', description: 'd', transcript: null,
    });
    expect(result.verdict).toBe('uncertain');
  });
});

describe('scoreForRequest prompt content', () => {
  it('includes title, channel, and history', async () => {
    channelHistory = { approved: 3, rejected: 1 };
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"clear_yes","reason":"ok","confidence":0.9}');
    await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 'Intro to Python', channel: 'CS Dojo',
      description: 'Learn Python basics.', transcript: null,
    });
    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Intro to Python');
    expect(prompt).toContain('CS Dojo');
    expect(prompt).toContain('3 previously approved');
    expect(prompt).toContain('1 previously rejected');
  });

  it('truncates long descriptions', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"clear_yes","reason":"ok","confidence":0.9}');
    const longDesc = 'a'.repeat(1000);
    await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 'Test', channel: 'Test', description: longDesc, transcript: null,
    });
    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('...');
    expect(prompt.length).toBeLessThan(longDesc.length + 500);
  });

  it('includes transcript excerpt when provided', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"clear_yes","reason":"ok","confidence":0.9}');
    await scoreForRequest({
      requestId: 'r1', userId: 'u1', url: 'https://x',
      title: 'Test', channel: 'Test', description: 'desc',
      transcript: 'Hello world this is a transcript',
    });
    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Transcript excerpt');
    expect(prompt).toContain('Hello world');
  });
});

describe('scoreForRequest', () => {
  it('writes guard_eval row and returns verdict', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '{"verdict":"clear_yes","reason":"Family-friendly coding tutorial.","confidence":0.95}'
    );
    const result = await scoreForRequest({
      requestId: 'req-1', userId: 'user-1', url: 'https://youtube.com/watch?v=abc',
      title: 'Learn Python', channel: 'CS Dojo', description: 'Python tutorial', transcript: null,
    });

    expect(result.verdict).toBe('clear_yes');
    expect(result.confidence).toBe(0.95);

    const insertCall = mockRun.mock.calls.find(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'eval_id' in (c[0] as Record<string, unknown>)
    );
    expect(insertCall).toBeDefined();
    const row = insertCall?.[0] as Record<string, unknown>;
    expect(row['prompt_version']).toBe('v1');
    expect(row['gemma_verdict']).toBe('clear_yes');
    expect(row['request_id']).toBe('req-1');
    expect(row['url']).toBe('https://youtube.com/watch?v=abc');
    expect(row['request_type']).toBe('video');
    expect(row['subject_text']).toBeNull();
    expect(row['interest_id']).toBeNull();
  });

  it('defaults to uncertain when Ollama fails', async () => {
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));
    const result = await scoreForRequest({
      requestId: 'req-2', userId: 'user-1', url: 'https://youtube.com/watch?v=xyz',
      title: 'Test', channel: 'Test', description: '', transcript: null,
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });

  it('skips Ollama when a prior eval exists for the request', async () => {
    priorEval = { gemma_verdict: 'clear_no', gemma_reason: 'cached', gemma_confidence: 0.7 };
    const result = await scoreForRequest({
      requestId: 'req-3', userId: 'user-1', url: 'https://x',
      title: 't', channel: 'c', description: 'd', transcript: null,
    });
    expect(result.verdict).toBe('clear_no');
    expect(result.reason).toBe('cached');
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });
});

describe('evaluateCandidate', () => {
  it('writes guard_eval row with request_id NULL and returns verdict', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '{"verdict":"clear_yes","reason":"Looks fine.","confidence":0.8}'
    );
    const result = await evaluateCandidate({
      candidateId: 'cand-1', userId: 'user-1',
      url: 'https://youtube.com/watch?v=abc', title: 'Some video',
    });

    expect(result.verdict).toBe('clear_yes');

    const insertCall = mockRun.mock.calls.find(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'eval_id' in (c[0] as Record<string, unknown>)
    );
    expect(insertCall).toBeDefined();
    const row = insertCall?.[0] as Record<string, unknown>;
    expect(row['request_id']).toBeNull();
    expect(row['url']).toBe('https://youtube.com/watch?v=abc');
    expect(row['gemma_verdict']).toBe('clear_yes');
    expect(row['prompt_version']).toBe('v1');
    expect(row['request_type']).toBe('candidate');
    expect(row['subject_text']).toBeNull();
    expect(row['interest_id']).toBeNull();
  });

  it('defaults to uncertain when Ollama fails', async () => {
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));
    const result = await evaluateCandidate({
      candidateId: 'cand-2', userId: 'user-1',
      url: 'https://youtube.com/watch?v=xyz', title: 'Some video',
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });
});

describe('evaluateKidInterest', () => {
  it('builds the prompt from raw label + populated search_terms', async () => {
    interestRow = { search_terms: '["bird identification","backyard birds","bird feeders","spotting scopes"]' };
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"clear_yes","reason":"Hobby topic.","confidence":0.9}');

    await evaluateKidInterest({ userId: 'user-1', interestId: 'bird_watching', rawLabel: 'Bird Watching' });

    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Bird Watching');
    expect(prompt).toContain('bird identification');
    expect(prompt).toContain('backyard birds');
    expect(prompt).toContain('aged 10-12');
  });

  it('writes a guard_eval row tagged kid_interest with subject_text and interest_id', async () => {
    interestRow = { search_terms: '["a","b","c","d"]' };
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"clear_yes","reason":"OK.","confidence":0.8}');

    const result = await evaluateKidInterest({
      userId: 'user-1', interestId: 'bird_watching', rawLabel: 'Bird Watching',
    });
    expect(result.verdict).toBe('clear_yes');

    const insertCall = mockRun.mock.calls.find(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'eval_id' in (c[0] as Record<string, unknown>)
    );
    expect(insertCall).toBeDefined();
    const row = insertCall?.[0] as Record<string, unknown>;
    expect(row['request_type']).toBe('kid_interest');
    expect(row['subject_text']).toBe('Bird Watching');
    expect(row['interest_id']).toBe('bird_watching');
    expect(row['prompt_version']).toBe('kid-interest-v1');
    expect(row['request_id']).toBeNull();
    expect(row['url']).toBe('interest:bird_watching');
  });

  it('falls back to a no-terms-yet phrasing when search_terms is missing or invalid', async () => {
    interestRow = { search_terms: 'not-json' };
    vi.mocked(ollamaGenerate).mockResolvedValue('{"verdict":"uncertain","reason":"x","confidence":0.5}');

    await evaluateKidInterest({ userId: 'user-1', interestId: 'x', rawLabel: 'Whatever' });

    const prompt = vi.mocked(ollamaGenerate).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('No search queries have been generated');
  });

  it('defaults to uncertain when Ollama fails', async () => {
    interestRow = { search_terms: '[]' };
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));

    const result = await evaluateKidInterest({ userId: 'user-1', interestId: 'x', rawLabel: 'Whatever' });
    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });
});
