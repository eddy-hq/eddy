import { describe, it, expect, vi } from 'vitest';
import { ollamaGenerate, parseOllamaJson } from './ollama';

vi.mock('./config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b', NODE_ENV: 'test' },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const passThrough = (parsed: unknown): unknown => parsed;

describe('parseOllamaJson', () => {
  it('parses a pure JSON object and runs the validator', () => {
    const out = parseOllamaJson<{ a: number }>('{"a":1}', 'object', (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const p = parsed as Record<string, unknown>;
      return typeof p['a'] === 'number' ? { a: p['a'] } : null;
    });
    expect(out).toEqual({ a: 1 });
  });

  it('parses a pure JSON array and runs the validator', () => {
    const out = parseOllamaJson<number[]>('[1,2,3]', 'array', (parsed) =>
      Array.isArray(parsed) ? (parsed as number[]) : null,
    );
    expect(out).toEqual([1, 2, 3]);
  });

  it('extracts an object embedded in surrounding prose', () => {
    const raw = "Sure, here's the result: {\"verdict\":\"ok\"}\nDone.";
    const out = parseOllamaJson<{ verdict: string }>(raw, 'object', (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const v = (parsed as Record<string, unknown>)['verdict'];
      return typeof v === 'string' ? { verdict: v } : null;
    });
    expect(out).toEqual({ verdict: 'ok' });
  });

  it('extracts an array embedded in surrounding prose', () => {
    const raw = 'Here you go:\n["a","b"]\nThanks.';
    const out = parseOllamaJson<string[]>(raw, 'array', (parsed) =>
      Array.isArray(parsed) ? (parsed as string[]) : null,
    );
    expect(out).toEqual(['a', 'b']);
  });

  it('returns null when the bracketed content is malformed JSON', () => {
    expect(parseOllamaJson('{not json}', 'object', passThrough)).toBeNull();
    expect(parseOllamaJson('[bad json]', 'array', passThrough)).toBeNull();
  });

  it('returns null when the validator rejects the parsed value', () => {
    const out = parseOllamaJson<{ x: number }>('{"x":"not a number"}', 'object', (parsed) => {
      const p = parsed as Record<string, unknown>;
      return typeof p['x'] === 'number' ? { x: p['x'] } : null;
    });
    expect(out).toBeNull();
  });

  it('returns null when there are no brackets at all', () => {
    expect(parseOllamaJson('totally not json', 'object', passThrough)).toBeNull();
    expect(parseOllamaJson('totally not json', 'array', passThrough)).toBeNull();
  });

  it('returns null on shape mismatch (asked array, only object present)', () => {
    expect(parseOllamaJson('only an {"obj":1} here', 'array', passThrough)).toBeNull();
  });

  it('lets the validator reshape with defaults', () => {
    interface Verdict { verdict: string; confidence: number }
    const out = parseOllamaJson<Verdict>('{"verdict":"ok"}', 'object', (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const p = parsed as Record<string, unknown>;
      const v = p['verdict'];
      if (typeof v !== 'string') return null;
      return {
        verdict: v,
        confidence: typeof p['confidence'] === 'number' ? p['confidence'] : 0.5,
      };
    });
    expect(out).toEqual({ verdict: 'ok', confidence: 0.5 });
  });
});

describe('ollamaGenerate request body', () => {
  it('sends truncate and shift as top-level fields, not model options', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ response: '{}', done: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await ollamaGenerate('prompt', undefined, undefined, {
        temperature: 0, num_predict: 10, think: false, keep_alive: '30m', truncate: false, shift: false,
      });
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as Record<string, unknown>;
      expect(body).toMatchObject({ truncate: false, shift: false, think: false, keep_alive: '30m' });
      expect(body['options']).toEqual({ temperature: 0, num_predict: 10 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
