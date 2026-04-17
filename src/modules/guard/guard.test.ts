import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseVerdict, buildPrompt, scoreForRequest, PROMPT_VERSION } from './index';

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../ollama', () => ({
  ollamaGenerate: vi.fn(),
}));

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ approved: 2, rejected: 0 })),
      run: vi.fn(),
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';

describe('parseVerdict', () => {
  it('parses a clean JSON response', () => {
    const result = parseVerdict(
      '{"verdict":"clear_yes","reason":"Educational coding content.","confidence":0.9}'
    );
    expect(result.verdict).toBe('clear_yes');
    expect(result.reason).toBe('Educational coding content.');
    expect(result.confidence).toBe(0.9);
  });

  it('extracts JSON embedded in preamble text', () => {
    const result = parseVerdict(
      'Sure, here is my assessment:\n{"verdict":"uncertain","reason":"Ambiguous content.","confidence":0.5}\nDone.'
    );
    expect(result.verdict).toBe('uncertain');
  });

  it('clamps confidence to 0–1', () => {
    const result = parseVerdict('{"verdict":"clear_no","reason":"Violence.","confidence":1.5}');
    expect(result.confidence).toBe(1);
  });

  it('throws on missing JSON', () => {
    expect(() => parseVerdict('no json here')).toThrow('No JSON block');
  });

  it('throws on invalid verdict value', () => {
    expect(() => parseVerdict('{"verdict":"maybe","reason":"x","confidence":0.5}')).toThrow(
      'Unexpected verdict value'
    );
  });
});

describe('buildPrompt', () => {
  it('includes title, channel, and history', () => {
    const prompt = buildPrompt({
      requestId: 'r1',
      userId: 'u1',
      url: 'https://youtube.com/watch?v=abc',
      title: 'Intro to Python',
      channel: 'CS Dojo',
      description: 'Learn Python basics.',
      transcript: null,
      channelHistory: { approved: 3, rejected: 1 },
    });
    expect(prompt).toContain('Intro to Python');
    expect(prompt).toContain('CS Dojo');
    expect(prompt).toContain('3 previously approved');
    expect(prompt).toContain('1 previously rejected');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'a'.repeat(1000);
    const prompt = buildPrompt({
      requestId: 'r1',
      userId: 'u1',
      url: 'https://youtube.com/watch?v=abc',
      title: 'Test',
      channel: 'Test',
      description: longDesc,
      transcript: null,
      channelHistory: { approved: 0, rejected: 0 },
    });
    expect(prompt).toContain('...');
    expect(prompt.length).toBeLessThan(longDesc.length + 500);
  });

  it('includes transcript excerpt when provided', () => {
    const prompt = buildPrompt({
      requestId: 'r1',
      userId: 'u1',
      url: 'https://youtube.com/watch?v=abc',
      title: 'Test',
      channel: 'Test',
      description: 'desc',
      transcript: 'Hello world this is a transcript',
      channelHistory: { approved: 0, rejected: 0 },
    });
    expect(prompt).toContain('Transcript excerpt');
    expect(prompt).toContain('Hello world');
  });
});

describe('scoreForRequest', () => {
  beforeEach(() => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '{"verdict":"clear_yes","reason":"Family-friendly coding tutorial.","confidence":0.95}'
    );
  });

  it('writes guard_eval row and returns verdict', async () => {
    const { db } = await import('../../db/client');
    const mockRun = vi.fn();
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn(() => ({ approved: 0, rejected: 0 })), run: mockRun } as unknown as ReturnType<typeof db.prepare>);

    const result = await scoreForRequest({
      requestId: 'req-1',
      userId: 'user-1',
      url: 'https://youtube.com/watch?v=abc',
      title: 'Learn Python',
      channel: 'CS Dojo',
      description: 'Python tutorial',
      transcript: null,
    });

    expect(result.verdict).toBe('clear_yes');
    expect(result.confidence).toBe(0.95);
    expect(mockRun).toHaveBeenCalledTimes(2); // guard_eval insert + requests update
    const insertCall = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertCall['prompt_version']).toBe(PROMPT_VERSION);
    expect(insertCall['gemma_verdict']).toBe('clear_yes');
  });

  it('defaults to uncertain when Ollama fails', async () => {
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));
    const { db } = await import('../../db/client');
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn(() => ({ approved: 0, rejected: 0 })), run: vi.fn() } as unknown as ReturnType<typeof db.prepare>);

    const result = await scoreForRequest({
      requestId: 'req-2',
      userId: 'user-1',
      url: 'https://youtube.com/watch?v=xyz',
      title: 'Test',
      channel: 'Test',
      description: '',
      transcript: null,
    });

    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });
});
