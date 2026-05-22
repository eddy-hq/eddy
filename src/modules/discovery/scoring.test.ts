import { describe, it, expect, vi } from 'vitest';
import {
  overrideTimeSensitivity,
  parseScoringVerdict,
  buildScoringPrompt,
  normalizeScoringWhy,
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

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

vi.mock('../../db/client', () => ({
  db: { prepare: vi.fn() },
}));

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

  it('parses a voice-style why that is not the video title', () => {
    const title = 'Tool Calling Is Not Just Plumbing for AI Agents — Roy Derks';
    const raw = `[{"index":1,"connection":8,"quality":7,"time_sensitivity":"standard","why":"I thought you'd like this because it gets into how agent tools are designed, not just wired up."}]`;
    const out = parseScoringVerdict(raw);

    expect(out).toHaveLength(1);
    expect(out?.[0]?.why).not.toBe(title);
    expect(out?.[0]?.why).toMatch(/[.!?]$/);
  });
});

describe('normalizeScoringWhy', () => {
  it('rejects title parroting', () => {
    const title = 'Tool Calling Is Not Just Plumbing for AI Agents — Roy Derks';

    expect(normalizeScoringWhy(title, title)).toBeNull();
  });

  it('trims usable why text', () => {
    expect(normalizeScoringWhy(
      'A title',
      '  I thought you would like this because it connects AI agents to practical tool design.  ',
    )).toBe('I thought you would like this because it connects AI agents to practical tool design.');
  });
});

describe('buildScoringPrompt', () => {
  it('numbers each video line and includes interest + followed-person tags', () => {
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
          personId: null,
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
          personId: 'p1',
          personName: 'Simon Peyton Jones',
        },
        {
          index: 3,
          candidateId: 'c3',
          title: 'New compiler talk',
          channel: 'Some Channel',
          durationSecs: 1500,
          publishedAt: null,
          interestLabel: null,
          expertise: null,
          sourceType: 'subscription',
          personId: 'p2',
          personName: 'Jane Compiler',
        },
      ],
      '"functional programming" (deep)',
    );

    expect(prompt).toContain('1. "Tail-call optimization in OCaml"');
    expect(prompt).toContain('[seeded by interest: "functional programming", deep]');
    expect(prompt).toContain('2. "Old talk on monads"');
    expect(prompt).toContain('[back-catalog from a person you follow: Simon Peyton Jones]');
    expect(prompt).toContain('3. "New compiler talk"');
    expect(prompt).toContain('[new upload from a person you follow: Jane Compiler]');
    expect(prompt).toContain('User interests (priority order, expertise): "functional programming" (deep)');
  });

  it('instructs Gemma to write the why in Eddy voice without title parroting', () => {
    const prompt = buildScoringPrompt(
      [{
        index: 1,
        candidateId: 'c1',
        title: 'Tool Calling Is Not Just Plumbing for AI Agents — Roy Derks',
        channel: 'AI Channel',
        durationSecs: 900,
        publishedAt: null,
        interestLabel: 'AI agents',
        expertise: 'deep',
        sourceType: 'interest_search',
        personId: null,
        personName: null,
      }],
      '"AI agents" (deep)',
    );

    expect(prompt).toContain('one-sentence reason in Eddy\'s voice');
    expect(prompt).toContain('write one warm, specific sentence');
    expect(prompt).toContain('Lead with the video\'s concrete value');
    expect(prompt).toContain('using "you" or "your" naturally');
    expect(prompt).toContain('For followed people, use the person only when their style or perspective matters');
    expect(prompt).toContain('If the best reason would only be provenance, give a low connection score');
  });

  it('omits the affinity section entirely when no statements are passed', () => {
    const prompt = buildScoringPrompt(
      [{
        index: 1, candidateId: 'c1', title: 'X', channel: 'Y',
        durationSecs: null, publishedAt: null,
        interestLabel: null, expertise: null,
        sourceType: 'interest_search', personId: null, personName: null,
      }],
      '"x" (deep)',
    );
    expect(prompt).not.toContain('Known preference patterns');
  });

  it('includes the affinity section and numbers each statement', () => {
    const prompt = buildScoringPrompt(
      [{
        index: 1, candidateId: 'c1', title: 'X', channel: 'Y',
        durationSecs: null, publishedAt: null,
        interestLabel: null, expertise: null,
        sourceType: 'interest_search', personId: null, personName: null,
      }],
      '"x" (deep)',
      [
        'Likes long-form technical explainers',
        'Skips reaction-style videos',
      ],
    );
    expect(prompt).toContain('Known preference patterns');
    expect(prompt).toContain('1. Likes long-form technical explainers');
    expect(prompt).toContain('2. Skips reaction-style videos');
  });
});
