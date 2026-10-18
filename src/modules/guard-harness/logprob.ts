// Read a rubric score's probability distribution from the model's token
// probabilities (brief §22 step 2, ADR-0017 "Calibrated scores").
//
// Ollama returns one entry per output token, each with its top alternatives.
// The walk rebuilds the output from the tokens' bytes, keeping each token's
// byte offsets, finds where each dimension's score digit sits in the JSON,
// and reads the alternatives at the token that carries it. The values are
// the model's raw distribution before the JSON schema constrained the choice,
// so the mass on '0'..'3' is renormalised over those four. Nothing is ever
// guessed: a score whose token can't be located is null.
import type { OllamaTokenLogprob } from '../../ollama';
import type { ScoreDistribution } from './util';

interface Span {
  start: number;
  end: number;
  token: OllamaTokenLogprob;
}

// A token's text as latin1, one char per UTF-8 byte, so offsets are byte
// offsets and a multi-byte character split across tokens still lines up.
function tokenBytes(t: { token: string; bytes?: number[] }): string {
  return Buffer.from(t.bytes ?? Buffer.from(t.token, 'utf8')).toString('latin1');
}

// The output rebuilt from its tokens, in latin1, with each token's span. Null
// when the tokens don't rebuild the response exactly: offsets can't be
// trusted then.
export function rebuildOutput(
  response: string,
  logprobs: readonly OllamaTokenLogprob[],
): { text: string; spans: Span[] } | null {
  let text = '';
  const spans: Span[] = [];
  for (const token of logprobs) {
    const piece = tokenBytes(token);
    spans.push({ start: text.length, end: text.length + piece.length, token });
    text += piece;
  }
  if (Buffer.from(text, 'latin1').toString('utf8') !== response) return null;
  return { text, spans };
}

const WS = new Set([' ', '\t', '\n', '\r']);

function skipWs(text: string, i: number): number {
  while (i < text.length && WS.has(text[i]!)) i++;
  return i;
}

// End (exclusive) of the JSON string opening at i, or -1.
function stringEnd(text: string, i: number): number {
  if (text[i] !== '"') return -1;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j + 1;
  }
  return -1;
}

// End (exclusive) of the JSON value starting at i, or -1. Nested values are
// skipped by bracket depth outside strings.
function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === '{' || text[i] === '[') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '"') {
        const e = stringEnd(text, j);
        if (e < 0) return -1;
        j = e - 1;
      } else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < text.length && !WS.has(text[j]!) && text[j] !== ',' && text[j] !== '}' && text[j] !== ']') j++;
  return j > i ? j : -1;
}

// Offset and raw text of each top-level value in a JSON object, by key. A key
// that appears twice is left out (ambiguous). Stops at the first malformed
// point, keeping what it found before it.
export function topLevelValues(text: string): Map<string, { start: number; raw: string }> {
  const out = new Map<string, { start: number; raw: string }>();
  const duplicated = new Set<string>();
  let i = skipWs(text, 0);
  if (text[i] !== '{') return out;
  i = skipWs(text, i + 1);
  while (i < text.length && text[i] !== '}') {
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) break;
    const key = text.slice(i + 1, keyEnd - 1);
    i = skipWs(text, keyEnd);
    if (text[i] !== ':') break;
    i = skipWs(text, i + 1);
    const end = valueEnd(text, i);
    if (end < 0) break;
    if (out.has(key)) duplicated.add(key);
    out.set(key, { start: i, raw: text.slice(i, end) });
    i = skipWs(text, end);
    if (text[i] === ',') i = skipWs(text, i + 1);
    else break;
  }
  for (const key of duplicated) out.delete(key);
  return out;
}

const SCORE_DIGITS = ['0', '1', '2', '3'] as const;

// The distribution over 0–3 for the single-digit value at `offset`, read from
// the token carrying it. The token may carry other text around the digit (a
// leading space, a trailing comma); an alternative counts for digit d only if
// it is the same text up to the digit, then d, then nothing or a JSON
// boundary (whitespace, ',', '}', ']'). Alternatives that don't line up count
// as no mass. Null if no token covers the offset.
function digitDistribution(spans: readonly Span[], text: string, offset: number): ScoreDistribution | null {
  const span = spans.find((s) => s.start <= offset && offset < s.end);
  if (!span) return null;
  const prefix = text.slice(span.start, offset);
  const seen = new Map<string, number>();
  for (const alt of [...(span.token.top_logprobs ?? []), span.token]) {
    const piece = tokenBytes(alt);
    if (!seen.has(piece) && Number.isFinite(alt.logprob)) seen.set(piece, alt.logprob);
  }
  const mass = [0, 0, 0, 0];
  for (const [piece, logprob] of seen) {
    if (!piece.startsWith(prefix)) continue;
    const digit = SCORE_DIGITS.indexOf(piece[prefix.length] as (typeof SCORE_DIGITS)[number]);
    if (digit < 0) continue;
    // The digit must end the value: nothing after it, or a JSON boundary.
    // '12', '1.5', '0e2' or '2x' is not a score of 1, 1, 0 or 2.
    if (!/^(|[\s,}\]][\s\S]*)$/.test(piece.slice(prefix.length + 1))) continue;
    mass[digit]! += Math.exp(logprob);
  }
  const total = mass.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return mass.map((m) => m / total) as unknown as ScoreDistribution;
}

// One distribution per dimension, keyed by the caller's dimension names;
// `outputKeys` maps each to its JSON key in the model's output. Null for a
// dimension whose value is missing, not a single digit 0–3, or not on a
// token; every dimension is null if the tokens don't rebuild the response.
export function scoreDistributions(
  response: string,
  logprobs: readonly OllamaTokenLogprob[],
  outputKeys: Readonly<Record<string, string>>,
): Record<string, ScoreDistribution | null> {
  const out: Record<string, ScoreDistribution | null> = {};
  const rebuilt = rebuildOutput(response, logprobs);
  const values = rebuilt ? topLevelValues(rebuilt.text) : new Map<string, { start: number; raw: string }>();
  for (const [dimension, key] of Object.entries(outputKeys)) {
    const value = values.get(key);
    out[dimension] = rebuilt && value && /^[0-3]$/.test(value.raw)
      ? digitDistribution(rebuilt.spans, rebuilt.text, value.start)
      : null;
  }
  return out;
}
