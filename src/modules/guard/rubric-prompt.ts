// candidate-v4: the model scores the rubric; code decides the verdict
// (Phase 6a). The model returns per-dimension scores, hard stops, flags and
// one short reason; verdictFromScores applies the limits table.
//
// Layout is static-first. Everything before VIDEO_MARKER — the rubric, rules
// and output instructions — is byte-identical on every call, so Ollama reuses
// its KV cache for it and only prefills the per-video tail. Nothing
// per-candidate (age band, date, id, video data) may enter the prefix. The age
// band is not in the prompt at all: severity is scored band-independently and
// the band only enters verdictFromScores.
import { parseOllamaJson } from '../../ollama';
import {
  DIMENSIONS,
  DIMENSION_KEYS,
  FLAGS,
  FLAG_KEYS,
  HARD_STOPS,
  HARD_STOP_KEYS,
  RUBRIC_VERSION,
  type HardStop,
  type HardStopLevel,
  type RubricDimension,
  type RubricFlag,
  type RubricScore,
  type RubricScores,
} from './rubric';

// v4.1: descriptions are cleaned of links and promo lines before clipping,
// and the transcript excerpt is spread across the video. Bump the prompt
// version when the inputs or layout change; rubric edits bump RUBRIC_VERSION.
export const CANDIDATE_V4_PROMPT_VERSION = 'candidate-v4.1';
export const SECOND_PASS_V4_PROMPT_VERSION = 'candidate-transcript-v4.1';
export const SECOND_PASS_V4_NO_TRANSCRIPT_PROMPT_VERSION = 'candidate-transcript-v4.1-no-transcript';

// Upper bound on the rendered tags line. Uploaders stuff tags; a few hundred
// characters carries the signal without crowding out the rest of the prompt.
const TAGS_MAX_CHARS = 300;

export function formatTags(tags: readonly string[] | null | undefined): string {
  let out = '';
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (!tag) continue;
    const next = out ? `${out}, ${tag}` : tag;
    if (next.length > TAGS_MAX_CHARS) break;
    out = next;
  }
  return out;
}

// Caps on the per-video tail. The M4's Ollama runs gemma4:e4b at a 4096-token
// context; a request asking for a different num_ctx would reload the model
// under live traffic, so the whole prompt plus output has to fit in 4096.
export const DESCRIPTION_MAX_CHARS = 500;
export const TRANSCRIPT_MAX_CHARS = 2000;
// Reason is capped by instruction (~20 words); this is the stored ceiling.
const REASON_MAX_CHARS = 200;

// Lines that are promotion, not content: links, socials, sponsor and
// affiliate codes, merch, subscribe calls, business contacts. Measured on the
// stored metadata, 84% of non-empty descriptions carry links in their first
// 500 characters, so without this the clip is mostly boilerplate.
const PROMO_LINE = /(https?:\/\/|www\.|\.(com|co\.uk|gg|ly|tv)\b|@[a-z0-9_.]{2,}|\b(instagram|insta|twitter|tiktok|discord|twitch|facebook|patreon|snapchat|threads|merch|shop|store|subscribe|sub to|follow (me|us)|business|enquir|inquir|e-?mail|contact|sponsor|affiliate|promo code|use code|discount|% off|link in|links below|join (my|the) (channel|membership))\b)/i;
const CHAPTER_LINE = /^\s*\(?\d{1,2}:\d{2}(:\d{2})?\)?\s+\S/;
const HASHTAG_LINE = /^\s*(#[\p{L}\p{N}_]+[\s,]*)+$/u;

// Keep what describes the video: prose and chapter titles. Chapter lines are
// kept even when they would match a promo word, because a chapter title says
// what is in that part of the video.
export function cleanDescription(description: string): string {
  const kept: string[] = [];
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (CHAPTER_LINE.test(line)) {
      kept.push(line);
      continue;
    }
    if (HASHTAG_LINE.test(line) || PROMO_LINE.test(line)) continue;
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    kept.push(line);
  }
  return kept.join(' · ');
}

// Slices taken across a long transcript: the opening is often intro and
// subscribe calls, and what decides a verdict can come anywhere.
const TRANSCRIPT_SLICES = 4;
const SLICE_SEPARATOR = ' … ';

// Up to `max` characters of transcript: all of it when it fits, otherwise
// TRANSCRIPT_SLICES evenly spaced slices (start, middle, end), each trimmed to
// word boundaries.
export function excerptTranscript(transcript: string, max: number = TRANSCRIPT_MAX_CHARS): string {
  const text = transcript.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const sliceLen = Math.floor((max - SLICE_SEPARATOR.length * (TRANSCRIPT_SLICES - 1)) / TRANSCRIPT_SLICES);
  const slices: string[] = [];
  for (let i = 0; i < TRANSCRIPT_SLICES; i++) {
    const start = Math.round((i * (text.length - sliceLen)) / (TRANSCRIPT_SLICES - 1));
    let slice = text.slice(start, start + sliceLen);
    if (start > 0) slice = slice.replace(/^\S*\s/, '');
    if (start + sliceLen < text.length) slice = slice.replace(/\s\S*$/, '');
    slices.push(slice);
  }
  return slices.join(SLICE_SEPARATOR);
}

export const VIDEO_MARKER = 'VIDEO';

// Compact output keys. Every key is decoded on every call and decode is the
// main cost (~28 tok/s on the M4): these cut the output from ~116 to ~108
// tokens against the rubric's own key names. The prompt pairs each with its
// rubric label so the model isn't scoring a bare abbreviation.
export const DIMENSION_OUTPUT_KEYS: Readonly<Record<RubricDimension, string>> = {
  language: 'lang',
  violence: 'viol',
  frightening: 'fear',
  sexual: 'sex',
  substances: 'subs',
  dangerous: 'risk',
  commercial: 'comm',
  attitude: 'att',
};
export const HARD_STOP_OUTPUT_KEYS: Readonly<Record<HardStop, string>> = {
  self_harm: 'selfharm',
  hate: 'hate',
  child_sexualisation: 'childsex',
  manosphere: 'mano',
};
export const FLAG_OUTPUT_KEYS: Readonly<Record<RubricFlag, string>> = {
  adult_game: 'game18',
  loot_box: 'lootbox',
};

const dimKeys = DIMENSION_KEYS.map((k) => DIMENSION_OUTPUT_KEYS[k]);
const hardStopKeys = HARD_STOP_KEYS.map((k) => HARD_STOP_OUTPUT_KEYS[k]);
const flagKeys = FLAG_KEYS.map((k) => FLAG_OUTPUT_KEYS[k]);

function renderDimensions(): string {
  return DIMENSIONS.map((d) => {
    const lines = [`${DIMENSION_OUTPUT_KEYS[d.key]} — ${d.label}`];
    if (d.test) lines.push(`Test: ${d.test}`);
    d.anchors.forEach((a, i) => lines.push(`${i} ${a}`));
    lines.push(`Rules: ${d.rules.join('; ')}.`);
    return lines.join('\n');
  }).join('\n\n');
}

function renderHardStops(): string {
  return HARD_STOPS.map((h) => `${HARD_STOP_OUTPUT_KEYS[h.key]}: ${h.description}`).join('\n');
}

function renderFlags(): string {
  return FLAGS.map((f) => `${FLAG_OUTPUT_KEYS[f.key]}: ${f.label} — ${f.description}`).join('\n');
}

// Built once at load; identical for every call by construction.
export const RUBRIC_PROMPT_PREFIX = `You are a content safety scorer for a family media system (${RUBRIC_VERSION}). Score one YouTube video against the rubric below, from the details given at the end. Score how strong the content is, not whether any particular child may watch it: the family's age limits are applied separately, by code.

Scale for every dimension: 0 None, 1 Mild, 2 Moderate, 3 Severe. Score the level the video most likely reaches on the evidence. When the title, description or tags point to a level (a horror-game playthrough is Frightening 2), score that level without waiting for proof. A missing field is missing evidence, not a sign of safety or of risk.

DIMENSIONS

${renderDimensions()}

HARD STOPS — "none", "suspected" or "clear"
${renderHardStops()}
Hard stops fire only on clear evidence: "clear" needs the video to plainly be this. Suspected but unclear is "suspected". Grey-area content is scored on the dimensions instead.

FLAGS — true or false (facts, not severity)
${renderFlags()}

EVIDENCE
- The YouTube audience setting is chosen by the uploader. It is a fact about the upload, not a safety assurance: disturbing content has been marked made for kids.
- Channel history counts only this child's past requests from the channel.
- The creator thumbnail is not shown. A shock-bait title is a sign the content leans that way; score the content.

OUTPUT
Return only compact JSON on a single line, with these keys in this order:
- reason: one plain-English sentence of at most 20 words, suitable to show a parent, naming what drove the highest scores
- ${dimKeys.join(', ')}: integer 0 to 3
- ${hardStopKeys.join(', ')}: "none", "suspected" or "clear"
- ${flagKeys.join(', ')}: true or false

${VIDEO_MARKER}
`;

// JSON schema the output is constrained to. Flat, compact keys (above).
// `reason` first: measured on synthetic inputs, output length and latency are
// the same either way (the same tokens are decoded), so first costs nothing
// and gives the model its only reasoning step with thinking off.
export const RUBRIC_SCORES_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    ...Object.fromEntries(dimKeys.map((k) => [k, { type: 'integer', enum: [0, 1, 2, 3] }])),
    ...Object.fromEntries(hardStopKeys.map((k) => [k, { type: 'string', enum: ['none', 'suspected', 'clear'] }])),
    ...Object.fromEntries(flagKeys.map((k) => [k, { type: 'boolean' }])),
  },
  required: ['reason', ...dimKeys, ...hardStopKeys, ...flagKeys],
};

export interface RubricPromptInput {
  title: string;
  channel: string;
  description: string;
  tags?: readonly string[] | null;
  category?: string | null;
  madeForKids?: boolean | null;
  // Null when the channel is unknown — the line is then left out.
  channelHistory: { approved: number; rejected: number } | null;
  // Second pass only. Null or absent leaves the transcript line out.
  transcript?: string | null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// The per-video tail. Blank fields are omitted rather than printed empty.
export function renderVideoDetails(input: RubricPromptInput): string {
  const tags = formatTags(input.tags);
  const category = input.category?.trim() ?? '';
  const desc = clip(cleanDescription(input.description), DESCRIPTION_MAX_CHARS);
  const audience = input.madeForKids === true
    ? 'YouTube audience setting: made for kids'
    : input.madeForKids === false
      ? 'YouTube audience setting: not made for kids'
      : null;
  const h = input.channelHistory;
  const history = !h
    ? null
    : h.approved > 0 || h.rejected > 0
      ? `Channel history: ${h.approved} previously approved, ${h.rejected} previously rejected`
      : 'Channel history: no prior requests from this channel';
  const transcript = input.transcript?.trim()
    ? `Transcript excerpt:\n${excerptTranscript(input.transcript)}`
    : null;
  return [
    `Title: ${input.title}`,
    input.channel ? `Channel: ${input.channel}` : null,
    category ? `Category: ${category}` : null,
    desc ? `Description: ${desc}` : null,
    tags ? `Tags: ${tags}` : null,
    audience,
    history,
    transcript,
  ].filter((line): line is string => line !== null).join('\n');
}

export function buildRubricPrompt(input: RubricPromptInput): string {
  return `${RUBRIC_PROMPT_PREFIX}${renderVideoDetails(input)}\n`;
}

export interface ParsedRubricOutput {
  scores: RubricScores;
  reason: string;
}

function isScore(v: unknown): v is RubricScore {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

function isHardStopLevel(v: unknown): v is HardStopLevel {
  return v === 'none' || v === 'suspected' || v === 'clear';
}

// Strict: every key must be present and in range, or the call is a scoring
// error (→ uncertain upstream). A partial score set is never guessed at.
export function parseRubricOutput(raw: string): ParsedRubricOutput | null {
  return parseOllamaJson<ParsedRubricOutput>(raw, 'object', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    const dimensions = {} as RubricScores['dimensions'];
    for (const k of DIMENSION_KEYS) {
      const v = p[DIMENSION_OUTPUT_KEYS[k]];
      if (!isScore(v)) return null;
      dimensions[k] = v;
    }
    const hardStops = {} as RubricScores['hardStops'];
    for (const k of HARD_STOP_KEYS) {
      const v = p[HARD_STOP_OUTPUT_KEYS[k]];
      if (!isHardStopLevel(v)) return null;
      hardStops[k] = v;
    }
    const flags = {} as RubricScores['flags'];
    for (const k of FLAG_KEYS) {
      const v = p[FLAG_OUTPUT_KEYS[k]];
      if (typeof v !== 'boolean') return null;
      flags[k] = v;
    }
    const reasonRaw = typeof p['reason'] === 'string' ? p['reason'].trim() : '';
    const reason = reasonRaw ? reasonRaw.slice(0, REASON_MAX_CHARS) : 'No reason provided';
    return { scores: { dimensions, hardStops, flags }, reason };
  });
}
