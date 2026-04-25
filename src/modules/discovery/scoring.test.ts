import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSensitivity,
  clampScore,
  overrideTimeSensitivity,
  parseScoringVerdict,
  buildScoringPrompt,
} from './scoring';

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', () => ({
  ollamaGenerate: vi.fn(),
}));

vi.mock('../../db/client', () => ({
  db: { prepare: vi.fn() },
}));

describe('normalizeSensitivity', () => {
  it('passes "news" through', () => {
    expect(normalizeSensitivity('news')).toBe('news');
  });

  it('passes "evergreen" through, including mixed-case + whitespace', () => {
    expect(normalizeSensitivity('Evergreen')).toBe('evergreen');
    expect(normalizeSensitivity('  EVERGREEN  ')).toBe('evergreen');
  });

  it('passes "standard" through', () => {
    expect(normalizeSensitivity('standard')).toBe('standard');
  });

  it('falls back to "standard" on unknown values', () => {
    expect(normalizeSensitivity('whatever')).toBe('standard');
    expect(normalizeSensitivity(null)).toBe('standard');
    expect(normalizeSensitivity(undefined)).toBe('standard');
  });
});

describe('clampScore', () => {
  it('passes in-range numbers through', () => {
    expect(clampScore(0)).toBe(0);
    expect(clampScore(5.5)).toBe(5.5);
    expect(clampScore(10)).toBe(10);
  });

  it('clamps below 0 to 0', () => {
    expect(clampScore(-3)).toBe(0);
  });

  it('clamps above 10 to 10', () => {
    expect(clampScore(15)).toBe(10);
  });

  it('returns null for non-finite or non-number input', () => {
    expect(clampScore(NaN)).toBeNull();
    expect(clampScore(Infinity)).toBeNull();
    expect(clampScore('7')).toBeNull();
    expect(clampScore(undefined)).toBeNull();
  });
});

describe('overrideTimeSensitivity', () => {
  it('overrides match-highlights titles to news', () => {
    expect(overrideTimeSensitivity('Arsenal vs Chelsea — Match Highlights', 'standard')).toBe('news');
  });

  it('overrides team-vs-team score patterns to news', () => {
    expect(overrideTimeSensitivity('Liverpool 3-0 Man United Full Match', 'standard')).toBe('news');
  });

  it('overrides season-tag titles to news', () => {
    expect(overrideTimeSensitivity('Premier League 2024/25 Recap', 'standard')).toBe('news');
  });

  it('returns the model verdict when no pattern matches', () => {
    expect(overrideTimeSensitivity('Intro to Functional Programming', 'evergreen')).toBe('evergreen');
    expect(overrideTimeSensitivity('Intro to Functional Programming', 'standard')).toBe('standard');
  });

  it('never overrides Gemma\'s "news" down', () => {
    expect(overrideTimeSensitivity('Generic title', 'news')).toBe('news');
  });

  it('returns the model verdict when title is null', () => {
    expect(overrideTimeSensitivity(null, 'standard')).toBe('standard');
  });
});

describe('parseScoringVerdict', () => {
  it('parses a clean JSON array', () => {
    const raw = '[{"index":1,"connection":7,"quality":8,"time_sensitivity":"standard","why":"x"}]';
    const out = parseScoringVerdict(raw);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.connection).toBe(7);
  });

  it('extracts a JSON array embedded in preamble', () => {
    const raw = 'Here are the scores:\n[{"index":1,"connection":6,"quality":5,"time_sensitivity":"news","why":"y"}]\nDone.';
    const out = parseScoringVerdict(raw);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.time_sensitivity).toBe('news');
  });

  it('falls back to per-object parsing when no array is present', () => {
    const raw = '{"index":1,"connection":7,"quality":6,"why":"a"}\n{"index":2,"connection":4,"quality":3,"why":"b"}';
    const out = parseScoringVerdict(raw);
    expect(out).toHaveLength(2);
    expect(out?.[1]?.index).toBe(2);
  });

  it('returns null on malformed input with no parseable JSON', () => {
    expect(parseScoringVerdict('totally not json')).toBeNull();
  });
});

describe('buildScoringPrompt', () => {
  it('numbers each video line and includes interest + back-catalog tags', () => {
    const prompt = buildScoringPrompt(
      [
        {
          index: 1,
          candidateId: 'c1',
          title: 'Tail-call optimization in OCaml',
          channel: 'CS Channel',
          durationSecs: 720,
          publishedAt: null,
          interestLabel: 'functional programming',
          expertise: 'deep',
          sourceType: 'interest_search',
          personName: null,
        },
        {
          index: 2,
          candidateId: 'c2',
          title: 'Old talk on monads',
          channel: 'Some Channel',
          durationSecs: 1800,
          publishedAt: null,
          interestLabel: null,
          expertise: null,
          sourceType: 'person_backcatalog',
          personName: 'Simon Peyton Jones',
        },
      ],
      '"functional programming" (deep)',
    );

    expect(prompt).toContain('1. "Tail-call optimization in OCaml"');
    expect(prompt).toContain('[seeded by interest: "functional programming", deep]');
    expect(prompt).toContain('2. "Old talk on monads"');
    expect(prompt).toContain('[back-catalog from a person you follow: Simon Peyton Jones]');
    expect(prompt).toContain('User interests (priority order, expertise): "functional programming" (deep)');
  });
});
