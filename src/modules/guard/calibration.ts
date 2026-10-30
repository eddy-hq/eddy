// Calibrated rubric scores (brief §22 step 2, ADR-0017 amended 2026-10-30).
// Shared by the live candidate guard and the guard harness, so a replay and
// the live call read the model the same way. Pure: no DB, no config, no model
// call, so the harness can import this file directly without loading the
// guard module's DB connection.
//
// Reading a score's distribution: Ollama returns one entry per output token,
// each with its top alternatives. The walk rebuilds the output from the
// tokens' bytes, keeping each token's byte offsets, finds where each
// dimension's score digit sits in the JSON, and reads the alternatives at the
// token that carries it. The values are the model's raw distribution before
// the JSON schema constrained the choice, so the mass on '0'..'3' is
// renormalised over those four. Nothing is ever guessed: a score whose token
// can't be located is null.
//
// Deciding with it: for an age band, p_over is the largest probability, over
// the dimensions, that the score exceeds its limit. A clear_yes with p_over at
// or above a threshold τ, or with any dimension unread, becomes uncertain. It
// only ever tightens, and fails closed.
import type { OllamaTokenLogprob } from '../../ollama';
import { DIMENSIONS, type RubricDimension } from './rubric';

// Probabilities of scores 0, 1, 2 and 3, summing to 1.
export type ScoreDistribution = readonly [number, number, number, number];

// Alternatives asked for per token. The four score digits are normally the
// top four at a score position (checked on Ollama 0.34.3).
export const TOP_LOGPROBS = 5;

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
// as no mass. Null if no token covers the offset, or if that token carries no
// alternatives: the chosen digit alone would renormalise to certainty, which
// is a missing reading, not a confident one.
function digitDistribution(spans: readonly Span[], text: string, offset: number): ScoreDistribution | null {
  const span = spans.find((s) => s.start <= offset && offset < s.end);
  if (!span) return null;
  if (!Array.isArray(span.token.top_logprobs) || span.token.top_logprobs.length === 0) return null;
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

// Score limits by dimension for one age band (rubric.ts LIMITS).
export type Limits = Readonly<Record<string, number>>;

const MAX_SCORE = 3;

export interface POverDetail {
  // The largest probability, over the dimensions in the limits, that the
  // score is above its limit. Null when any of them has no distribution.
  pOver: number | null;
  // The dimension reaching it (the first, in the limits' order, on a tie).
  // Null when pOver is.
  dimension: string | null;
  // Dimensions with no distribution, in the limits' order.
  unread: string[];
}

export function pOverDetail(
  distributions: Readonly<Record<string, ScoreDistribution | null>> | undefined,
  limits: Limits,
): POverDetail {
  let max = -1;
  let dimension: string | null = null;
  const unread: string[] = [];
  for (const [key, limit] of Object.entries(limits)) {
    const d = distributions?.[key];
    if (!d) {
      unread.push(key);
      continue;
    }
    let p = 0;
    for (let s = limit + 1; s <= MAX_SCORE; s++) p += d[s] ?? 0;
    if (p > max) {
      max = p;
      dimension = key;
    }
  }
  if (!distributions || unread.length > 0) return { pOver: null, dimension: null, unread };
  // No limits at all: nothing can be over.
  if (dimension === null) return { pOver: 0, dimension: null, unread };
  return { pOver: max, dimension, unread };
}

// The largest probability, over the dimensions in `limits`, that the score is
// above its limit. Null when any of them has no distribution.
export function pOver(
  distributions: Readonly<Record<string, ScoreDistribution | null>> | undefined,
  limits: Limits,
): number | null {
  return pOverDetail(distributions, limits).pOver;
}

export type CalibratedVerdictLabel = 'clear_yes' | 'clear_no' | 'uncertain';

// The plain verdict tightened by τ: clear_yes stays clear_yes only when
// p_over is known and below τ; anything else is unchanged.
export function tightenVerdict(plain: CalibratedVerdictLabel, p: number | null, tau: number): CalibratedVerdictLabel {
  if (plain !== 'clear_yes') return plain;
  return p !== null && p < tau ? 'clear_yes' : 'uncertain';
}

// A probability as a parent-readable percentage: one decimal place under 10%,
// so a value just over a small τ doesn't read as equal to it; whole numbers
// from 10% up.
export function formatPercent(p: number): string {
  const pct = p * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${Number(pct.toFixed(1))}%`;
}

// What live calibration found on one rubric call, as guard_eval records it in
// rubric_scores_json: τ, p_over for the kid's limits band (null when a score's
// probabilities couldn't be read) and the dimension reaching it (null with
// p_over).
export interface CalibrationOutcome {
  tau: number;
  pOver: number | null;
  dimension: RubricDimension | null;
}

// Short parent-readable driver for a calibration escalation, phrased like
// describeDriver, e.g. "Violence: 7.2% chance over the limit, escalates at
// 4%". Rubric names and numbers only, so it is safe in logs and summaries.
export function describeCalibration(c: CalibrationOutcome): string {
  if (c.pOver === null) return 'Score probabilities unreadable: escalated';
  const label = c.dimension ? DIMENSIONS.find((x) => x.key === c.dimension)?.label ?? c.dimension : 'A dimension';
  return `${label}: ${formatPercent(c.pOver)} chance over the limit, escalates at ${formatPercent(c.tau)}`;
}
