import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

import {
  DIMENSION_OUTPUT_KEYS,
  FLAG_OUTPUT_KEYS,
  HARD_STOP_OUTPUT_KEYS,
  RUBRIC_PROMPT_PREFIX,
  RUBRIC_SCORES_SCHEMA,
  VIDEO_MARKER,
  buildRubricPrompt,
  parseRubricOutput,
  renderVideoDetails,
} from './rubric-prompt';
import { DIMENSIONS, HARD_STOPS, FLAGS } from './rubric';

const valid = {
  reason: 'Synthetic.',
  lang: 1, viol: 2, fear: 0, sex: 0, subs: 0, risk: 3, comm: 0, att: 0,
  selfharm: 'none', hate: 'suspected', childsex: 'none', mano: 'clear',
  game18: true, lootbox: false,
};

describe('RUBRIC_PROMPT_PREFIX', () => {
  it('renders every dimension anchor, hard stop and flag from rubric.ts', () => {
    for (const d of DIMENSIONS) {
      expect(RUBRIC_PROMPT_PREFIX).toContain(`${DIMENSION_OUTPUT_KEYS[d.key]} — ${d.label}`);
      for (const a of d.anchors) expect(RUBRIC_PROMPT_PREFIX).toContain(a);
    }
    for (const h of HARD_STOPS) expect(RUBRIC_PROMPT_PREFIX).toContain(h.description);
    for (const f of FLAGS) expect(RUBRIC_PROMPT_PREFIX).toContain(f.label);
  });

  it('ends at the video marker, so everything per-video comes after it', () => {
    expect(RUBRIC_PROMPT_PREFIX.endsWith(`${VIDEO_MARKER}\n`)).toBe(true);
  });

  // The M4 runs gemma4:e4b at a 4096-token context. The prefix measured
  // ~2,100 tokens at ~9,000 chars; a worst-case prompt (every field at its
  // cap, 2,000-char transcript) measured ~2,800 tokens. Keep well clear.
  it('fits the 4096-token context with every field at its cap', () => {
    const worst = buildRubricPrompt({
      title: 'T'.repeat(100),
      channel: 'C'.repeat(60),
      description: 'word '.repeat(2000),
      tags: Array.from({ length: 200 }, (_, i) => `tag${i}`),
      category: 'Entertainment',
      madeForKids: false,
      channelHistory: { approved: 10, rejected: 10 },
      transcript: 'spoken words '.repeat(2000),
    });
    expect(RUBRIC_PROMPT_PREFIX.length).toBeLessThan(10_000);
    expect(worst.length).toBeLessThan(13_000);
  });
});

describe('renderVideoDetails', () => {
  it('omits blank fields and unknown history', () => {
    const out = renderVideoDetails({ title: 'Only a title', channel: '', description: '  ', channelHistory: null });
    expect(out).toBe('Title: Only a title');
  });

  it('states the audience setting as a fact and puts the transcript last', () => {
    const out = renderVideoDetails({
      title: 'Synthetic', channel: 'Chan', description: 'Desc', tags: ['a', ' ', 'b'],
      category: 'Education', madeForKids: true, channelHistory: { approved: 0, rejected: 0 },
      transcript: 'Words.',
    });
    expect(out.split('\n')).toEqual([
      'Title: Synthetic',
      'Channel: Chan',
      'Category: Education',
      'Description: Desc',
      'Tags: a, b',
      'YouTube audience setting: made for kids',
      'Channel history: no prior requests from this channel',
      'Transcript excerpt:',
      'Words.',
    ]);
  });
});

describe('RUBRIC_SCORES_SCHEMA', () => {
  it('requires reason first, then every compact key', () => {
    expect(RUBRIC_SCORES_SCHEMA.required).toEqual([
      'reason',
      ...Object.values(DIMENSION_OUTPUT_KEYS),
      ...Object.values(HARD_STOP_OUTPUT_KEYS),
      ...Object.values(FLAG_OUTPUT_KEYS),
    ]);
    expect(Object.keys(RUBRIC_SCORES_SCHEMA.properties)[0]).toBe('reason');
  });
});

describe('parseRubricOutput', () => {
  it('maps compact keys back to rubric keys', () => {
    const p = parseRubricOutput(JSON.stringify(valid));
    expect(p).toEqual({
      reason: 'Synthetic.',
      scores: {
        dimensions: {
          language: 1, violence: 2, frightening: 0, sexual: 0,
          substances: 0, dangerous: 3, commercial: 0, attitude: 0,
        },
        hardStops: { self_harm: 'none', hate: 'suspected', child_sexualisation: 'none', manosphere: 'clear' },
        flags: { adult_game: true, loot_box: false },
      },
    });
  });

  it('caps the stored reason and fills a missing one', () => {
    expect(parseRubricOutput(JSON.stringify({ ...valid, reason: 'x'.repeat(500) }))?.reason).toHaveLength(200);
    expect(parseRubricOutput(JSON.stringify({ ...valid, reason: '' }))?.reason).toBe('No reason provided');
  });

  it('rejects anything partial or out of range', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing['lang'];
    expect(parseRubricOutput(JSON.stringify(missing))).toBeNull();
    expect(parseRubricOutput(JSON.stringify({ ...valid, lang: 1.5 }))).toBeNull();
    expect(parseRubricOutput(JSON.stringify({ ...valid, lang: '1' }))).toBeNull();
    expect(parseRubricOutput(JSON.stringify({ ...valid, mano: 'yes' }))).toBeNull();
    expect(parseRubricOutput(JSON.stringify({ ...valid, lootbox: 1 }))).toBeNull();
    expect(parseRubricOutput('[]')).toBeNull();
    expect(parseRubricOutput('nothing')).toBeNull();
  });
});
