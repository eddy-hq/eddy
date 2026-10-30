import { describe, expect, it } from 'vitest';
import type { OllamaTokenLogprob } from '../../ollama';
import {
  describeCalibration,
  formatPercent,
  pOver,
  pOverDetail,
  rebuildOutput,
  scoreDistributions,
  tightenVerdict,
  topLevelValues,
} from './calibration';
import { RECORDED_RESPONSE } from './logprob-fixture';

// Mirrors DIMENSION_OUTPUT_KEYS (rubric-prompt.ts); the adapter test checks
// the real mapping.
const KEYS = {
  language: 'lang', violence: 'viol', frightening: 'fear', sexual: 'sex',
  substances: 'subs', dangerous: 'risk', commercial: 'comm', attitude: 'att',
};

type Piece = string | { t: string; top: Array<[string, number]>; bytes?: number[] };

// A token stream from pieces: a plain string is a token with no alternatives.
function tokens(pieces: Piece[]): { response: string; logprobs: OllamaTokenLogprob[] } {
  const logprobs = pieces.map((p): OllamaTokenLogprob => {
    if (typeof p === 'string') return { token: p, logprob: 0 };
    const chosen = p.top.find(([t]) => t === p.t);
    return {
      token: p.t,
      logprob: chosen ? chosen[1] : 0,
      ...(p.bytes ? { bytes: p.bytes } : {}),
      top_logprobs: p.top.map(([token, logprob]) => ({ token, logprob })),
    };
  });
  const response = Buffer.concat(logprobs.map((l) => Buffer.from(l.bytes ?? Buffer.from(l.token, 'utf8')))).toString('utf8');
  return { response, logprobs };
}

// A full rubric output with every dimension 0 except where `score` overrides
// the token for a key.
function rubricPieces(score: Partial<Record<string, Piece[]>> = {}): Piece[] {
  const out: Piece[] = ['{"', 'reason', '":', ' "', 'Fine', '.",'];
  for (const key of Object.values(KEYS)) {
    out.push(' "', key, '":', ...(score[key] ?? [' ', { t: '0', top: [['0', -0.01], ['1', -5], ['2', -9], ['3', -12]] }]), ',');
  }
  out.push(' "', 'mano', '":', ' "', 'none', '"', '}');
  return out;
}

const ln = Math.log;

describe('scoreDistributions on a recorded response', () => {
  const d = scoreDistributions(RECORDED_RESPONSE.response, RECORDED_RESPONSE.logprobs, KEYS);
  const parsed = JSON.parse(RECORDED_RESPONSE.response) as Record<string, number>;

  it('locates every dimension', () => {
    for (const [dim, key] of Object.entries(KEYS)) {
      const dist = d[dim];
      expect(dist, dim).not.toBeNull();
      expect(dist!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      // The decoded score is the most likely of 0–3.
      expect(dist!.indexOf(Math.max(...dist!)), dim).toBe(parsed[key]);
    }
  });

  it('reads the split the model was unsure of', () => {
    // Recorded: '1' at -0.614, '0' at -0.779, '2' at -9.19, '3' at -14.429.
    const raw = [Math.exp(-0.779), Math.exp(-0.614), Math.exp(-9.19), Math.exp(-14.429)];
    const total = raw.reduce((a, b) => a + b, 0);
    raw.forEach((p, i) => expect(d['dangerous']![i]).toBeCloseTo(p / total, 10));
    expect(d['dangerous']![1]).toBeGreaterThan(0.5);
    expect(d['dangerous']![0]).toBeGreaterThan(0.4);
  });

  it('is unaffected by a key that holds digits split across tokens (game18)', () => {
    const values = topLevelValues(rebuildOutput(RECORDED_RESPONSE.response, RECORDED_RESPONSE.logprobs)!.text);
    expect(values.get('game18')?.raw).toBe('false');
  });
});

describe('scoreDistributions on crafted token streams', () => {
  it('renormalises over 0–3, dropping mass on other tokens', () => {
    const { response, logprobs } = tokens(rubricPieces({
      viol: [' ', { t: '1', top: [['1', ln(0.5)], ['2', ln(0.2)], ['\n', ln(0.2)], ['4', ln(0.1)]] }],
    }));
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['violence']![0]).toBe(0);
    expect(d['violence']![1]).toBeCloseTo(0.5 / 0.7, 10);
    expect(d['violence']![2]).toBeCloseTo(0.2 / 0.7, 10);
    expect(d['violence']![3]).toBe(0);
  });

  it('gives a digit missing from top_logprobs no mass', () => {
    const { response, logprobs } = tokens(rubricPieces({
      fear: [' ', { t: '0', top: [['0', ln(0.9)], ['1', ln(0.1)]] }],
    }));
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['frightening']).toEqual([0.9, 0.1, 0, 0].map((p) => expect.closeTo(p, 10)));
  });

  it('reads a digit merged with the space before it, counting only alternatives that line up', () => {
    const { response, logprobs } = tokens(rubricPieces({
      // ' 2' chosen; '2' without the space is another tokenisation of the
      // same position and is not comparable, so it carries no mass.
      sex: [{ t: ' 2', top: [[' 2', ln(0.6)], [' 1', ln(0.3)], ['2', ln(0.05)], [' 3', ln(0.05)]] }],
    }));
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['sexual']![1]).toBeCloseTo(0.3 / 0.95, 10);
    expect(d['sexual']![2]).toBeCloseTo(0.6 / 0.95, 10);
    expect(d['sexual']![3]).toBeCloseTo(0.05 / 0.95, 10);
  });

  it('reads a digit merged with the comma after it, ignoring a longer number', () => {
    const pieces = rubricPieces();
    // Replace the att value and its trailing comma with one '3,' token.
    const at = pieces.findIndex((p) => p === 'att');
    pieces.splice(at + 2, 3, ' ', { t: '3,', top: [['3,', ln(0.5)], ['2,', ln(0.3)], ['3', ln(0.1)], ['30', ln(0.1)]] });
    const { response, logprobs } = tokens(pieces);
    const d = scoreDistributions(response, logprobs, KEYS);
    // '3' alone is the same digit followed by something else; '30' isn't a
    // score at all.
    expect(d['attitude']).toEqual([0, 0, 0.3 / 0.9, 0.6 / 0.9].map((p) => expect.closeTo(p, 10)));
  });

  it('ignores alternatives that continue the number past the digit', () => {
    const { response, logprobs } = tokens(rubricPieces({
      comm: [' ', { t: '0', top: [['0', ln(0.1)], ['1.5', ln(0.5)], ['0e2', ln(0.2)], ['2x', ln(0.1)], ['1', ln(0.1)]] }],
    }));
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['commercial']).toEqual([0.5, 0.5, 0, 0].map((p) => expect.closeTo(p, 10)));
  });

  it('accepts an alternative that ends at a JSON boundary', () => {
    const { response, logprobs } = tokens(rubricPieces({
      comm: [' ', { t: '0', top: [['0', ln(0.4)], ['1}', ln(0.2)], ['2 ', ln(0.2)], ['3\n', ln(0.2)]] }],
    }));
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['commercial']).toEqual([0.4, 0.2, 0.2, 0.2].map((p) => expect.closeTo(p, 10)));
  });

  it('counts the chosen token when top_logprobs leaves it out', () => {
    const { response, logprobs } = tokens(rubricPieces({ subs: [' ', '1'] }));
    const subs = logprobs.find((l, i) => l.token === '1' && logprobs[i - 3]?.token === 'subs')!;
    subs.logprob = ln(0.4);
    subs.top_logprobs = [{ token: '0', logprob: ln(0.6) }];
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['substances']).toEqual([0.6, 0.4, 0, 0].map((p) => expect.closeTo(p, 10)));
  });

  it('gives null for a dimension the output does not carry', () => {
    const pieces = rubricPieces();
    const at = pieces.findIndex((p) => p === 'comm');
    pieces.splice(at - 1, 6);
    const { response, logprobs } = tokens(pieces);
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['commercial']).toBeNull();
    expect(d['language']).not.toBeNull();
  });

  it('gives null for a value split across two digit tokens', () => {
    const { response, logprobs } = tokens(rubricPieces({
      lang: [' ', { t: '1', top: [['1', ln(0.9)], ['0', ln(0.1)]] }, { t: '2', top: [['2', ln(1)]] }],
    }));
    expect(scoreDistributions(response, logprobs, KEYS)['language']).toBeNull();
  });

  it('gives null for a non-integer value', () => {
    const { response, logprobs } = tokens(rubricPieces({ risk: [' ', '"', '1', '"'] }));
    expect(scoreDistributions(response, logprobs, KEYS)['dangerous']).toBeNull();
  });

  it('gives null for a key that appears twice', () => {
    const pieces = rubricPieces();
    pieces.splice(pieces.length - 1, 0, ',', ' "', 'lang', '":', ' ', '3');
    const { response, logprobs } = tokens(pieces);
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['language']).toBeNull();
    expect(d['violence']).not.toBeNull();
  });

  it('is not fooled by a score-like phrase inside the reason', () => {
    const pieces = rubricPieces();
    pieces.splice(4, 1, 'says \\"lang\\": 3 and \\"viol\\":', '2');
    const { response, logprobs } = tokens(pieces);
    const d = scoreDistributions(response, logprobs, KEYS);
    expect(d['language']![0]).toBeGreaterThan(0.9);
    expect(d['violence']![0]).toBeGreaterThan(0.9);
  });

  it('keeps byte offsets right across a character split between tokens', () => {
    const pieces = rubricPieces();
    // 'é' is two UTF-8 bytes; each half arrives as its own token.
    pieces.splice(4, 1, { t: '�', top: [], bytes: [0xc3] }, { t: '�', top: [], bytes: [0xa9] }, 'tude');
    const { response, logprobs } = tokens(pieces);
    expect(response).toContain('étude');
    const d = scoreDistributions(response, logprobs, KEYS);
    for (const dim of Object.keys(KEYS)) expect(d[dim], dim).not.toBeNull();
  });

  it('gives null for a score token with a finite logprob but no alternatives', () => {
    const logprobs = RECORDED_RESPONSE.logprobs.map((l) => ({ token: l.token, logprob: l.logprob, bytes: l.bytes }));
    const d = scoreDistributions(RECORDED_RESPONSE.response, logprobs, KEYS);
    expect(Object.values(d).every((v) => v === null)).toBe(true);
    const empty = RECORDED_RESPONSE.logprobs.map((l) => ({ ...l, top_logprobs: [] }));
    expect(Object.values(scoreDistributions(RECORDED_RESPONSE.response, empty, KEYS)).every((v) => v === null)).toBe(true);
  });

  it('gives every dimension null when the tokens do not rebuild the response', () => {
    const { response, logprobs } = tokens(rubricPieces());
    const d = scoreDistributions(`${response} `, logprobs, KEYS);
    expect(Object.values(d).every((v) => v === null)).toBe(true);
  });

  it('gives null when every alternative has an unusable logprob', () => {
    const { response, logprobs } = tokens(rubricPieces({
      lang: [' ', { t: '0', top: [['0', Number.NEGATIVE_INFINITY]] }],
    }));
    logprobs.find((l) => l.token === '0')!.logprob = Number.NEGATIVE_INFINITY;
    expect(scoreDistributions(response, logprobs, KEYS)['language']).toBeNull();
  });
});

describe('pOverDetail', () => {
  const limits = { language: 2, violence: 1, attitude: 1 };

  it('names the dimension reaching p_over, the first on a tie', () => {
    const d = { language: [0.5, 0.2, 0.2, 0.1] as const, violence: [0.6, 0.3, 0.05, 0.05] as const, attitude: [0.9, 0, 0.1, 0] as const };
    const r = pOverDetail(d, limits);
    expect(r.pOver).toBeCloseTo(0.1, 10);
    expect(r.dimension).toBe('language');
    expect(r.unread).toEqual([]);
    expect(pOver(d, limits)).toBe(r.pOver);
  });

  it('is null, with every unread dimension listed, when any is missing', () => {
    const d = { language: [1, 0, 0, 0] as const, violence: null };
    expect(pOverDetail(d, limits)).toEqual({ pOver: null, dimension: null, unread: ['violence', 'attitude'] });
    expect(pOverDetail(undefined, limits)).toEqual({ pOver: null, dimension: null, unread: ['language', 'violence', 'attitude'] });
  });
});

describe('tightenVerdict', () => {
  it('only ever turns a clear_yes into uncertain, at or above τ or unread', () => {
    expect(tightenVerdict('clear_yes', 0.039, 0.04)).toBe('clear_yes');
    expect(tightenVerdict('clear_yes', 0.04, 0.04)).toBe('uncertain');
    expect(tightenVerdict('clear_yes', null, 0.04)).toBe('uncertain');
    expect(tightenVerdict('clear_no', null, 0.04)).toBe('clear_no');
    expect(tightenVerdict('uncertain', 0, 0.04)).toBe('uncertain');
  });
});

describe('describeCalibration', () => {
  it('names the dimension and the numbers', () => {
    expect(describeCalibration({ tau: 0.04, pOver: 0.072, dimension: 'violence' }))
      .toBe('Violence: 7.2% chance over the limit, escalates at 4%');
    expect(describeCalibration({ tau: 0.04, pOver: 0.35, dimension: 'dangerous' }))
      .toBe('Dangerous acts: 35% chance over the limit, escalates at 4%');
  });

  it('says when the probabilities could not be read', () => {
    expect(describeCalibration({ tau: 0.04, pOver: null, dimension: null })).toBe('Score probabilities unreadable: escalated');
  });

  it('keeps a value just over τ from reading as equal to it', () => {
    expect(formatPercent(0.0412)).toBe('4.1%');
    expect(formatPercent(0.04)).toBe('4%');
    expect(formatPercent(0.123)).toBe('12%');
  });
});
