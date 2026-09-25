import { config } from '../../config';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';

// Thumbnail safety floor (Phase 6a, brief §6). Every image the thumbnail
// picker would show — the creator thumbnail, a YouTube auto-frame, or an
// ffmpeg-sampled frame — is scored on the rubric's Violence, Frightening and
// Sexual dimensions and rejected if any score is above the floor. Anchors come
// from docs/guard-rubric.md; bump the version whenever the prompt changes.
export const THUMB_SAFETY_VERSION = 'thumb-safety-v1';

// Highest score on any dimension an image may have and still be shown.
export const THUMB_SAFETY_MAX_SCORE = 1;

// Smallest byte size a real YouTube thumbnail can have; below this i.ytimg.com
// is returning its grey "no such variant" placeholder.
const YT_PLACEHOLDER_BYTES = 2000;

export type ThumbSafetyDimension = 'violence' | 'frightening' | 'sexual';
const DIMENSIONS: ThumbSafetyDimension[] = ['violence', 'frightening', 'sexual'];

export interface ThumbSafetyScore {
  score: 0 | 1 | 2 | 3;
  reason: string;
}

export type ThumbSafetyError = 'fetch_failed' | 'model_error' | 'parse_error';

export interface ThumbSafetyVerdict {
  version: string;
  pass: boolean;
  // null when no score was produced (error) — an unscored image never passes.
  scores: Record<ThumbSafetyDimension, ThumbSafetyScore> | null;
  error?: ThumbSafetyError;
}

// Deterministic, no thinking pass, output constrained to the schema. Same
// model and keep_alive as the guard so a busy M4 isn't made to swap models.
const THUMB_SAFETY_CALL_OPTIONS = {
  temperature: 0,
  num_predict: 300,
  think: false,
  keep_alive: '30m',
};

const DIMENSION_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    score: { type: 'integer', enum: [0, 1, 2, 3] },
  },
  required: ['reason', 'score'],
};

// `reason` before `score` within each dimension so the model describes what it
// sees before it commits to a number.
const THUMB_SAFETY_SCHEMA = {
  type: 'object',
  properties: {
    violence: DIMENSION_SCHEMA,
    frightening: DIMENSION_SCHEMA,
    sexual: DIMENSION_SCHEMA,
  },
  required: DIMENSIONS,
};

const THUMB_SAFETY_PROMPT = `You are a content safety check for a family media system used by children. This image is a candidate thumbnail: a single still that will be shown on a child's screen. Judge only what is visible in this image.

Score it on three dimensions, 0-3 each:

Violence
- 0 None: no harm shown. Ordinary sport, cooking, science.
- 1 Mild: stylised or cartoon, no blood. Slapstick, blocky video-game combat, a hard football tackle, an animal hunting with no close-up.
- 2 Moderate: realistic with some blood, or a real fight. Realistic shooter gameplay, a boxing knockout, a real street fight, war footage, weapons pointed at people.
- 3 Severe: gore, torture, real serious injury or death. Graphic horror kills, real casualties, animal cruelty.
- Real scores a level higher than equivalent fiction.

Frightening
- 0 None: nothing unsettling.
- 1 Mild: spooky for fun, played light. Halloween costumes, cartoon monsters, a friendly ghost.
- 2 Moderate: meant to scare. Horror-game monsters (including kid-targeted horror characters), creepy or distorted faces, jump-scare imagery, disaster scenes.
- 3 Severe: designed to disturb, or real people in real danger or death. Graphic horror, real accident or death imagery, people in genuine peril.
- Real scores a level higher than fiction.

Sexual
- 0 None: nothing sexual.
- 1 Mild: kissing, romance, swimwear in a normal context (beach, swimming).
- 2 Moderate: suggestive poses, outfits or framing as the point of the image; thirst-trap composition.
- 3 Severe: nudity or explicit sexual content.

Give each dimension one short sentence of reason describing what is visible, then the score. If you are unsure between two levels, choose the higher one.`;

function parseVerdict(raw: string): Record<ThumbSafetyDimension, ThumbSafetyScore> | null {
  return parseOllamaJson(raw, 'object', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    const out = {} as Record<ThumbSafetyDimension, ThumbSafetyScore>;
    for (const dim of DIMENSIONS) {
      const d = p[dim];
      if (typeof d !== 'object' || d === null) return null;
      const score = (d as Record<string, unknown>)['score'];
      const reason = (d as Record<string, unknown>)['reason'];
      if (score !== 0 && score !== 1 && score !== 2 && score !== 3) return null;
      out[dim] = { score, reason: typeof reason === 'string' ? reason : '' };
    }
    return out;
  });
}

function failed(error: ThumbSafetyError): ThumbSafetyVerdict {
  return { version: THUMB_SAFETY_VERSION, pass: false, scores: null, error };
}

// Pure floor decision, exported so tests (and any other caller) share one rule.
export function passesThumbSafetyFloor(scores: Record<ThumbSafetyDimension, ThumbSafetyScore> | null): boolean {
  if (!scores) return false;
  return DIMENSIONS.every((dim) => scores[dim].score <= THUMB_SAFETY_MAX_SCORE);
}

// Score one image (base64, no data: prefix). Kid safety: any model or parse
// failure comes back as a failing verdict, never a passing one. Reasons are
// returned but not logged — they describe the image, and logs stay free of
// content detail.
export async function scoreThumbnailSafety(imageBase64: string, logCtx: Record<string, unknown> = {}): Promise<ThumbSafetyVerdict> {
  let raw: string;
  try {
    raw = await ollamaGenerate(
      THUMB_SAFETY_PROMPT,
      config.OLLAMA_GUARD_MODEL,
      [imageBase64],
      THUMB_SAFETY_CALL_OPTIONS,
      THUMB_SAFETY_SCHEMA,
    );
  } catch (err) {
    logger.warn({ err, ...logCtx, version: THUMB_SAFETY_VERSION }, 'Thumbnail safety: model call failed — rejecting image');
    return failed('model_error');
  }

  const scores = parseVerdict(raw);
  if (!scores) {
    logger.warn({ ...logCtx, version: THUMB_SAFETY_VERSION }, 'Thumbnail safety: unparseable response — rejecting image');
    return failed('parse_error');
  }

  const pass = passesThumbSafetyFloor(scores);
  logger.info({
    ...logCtx,
    version: THUMB_SAFETY_VERSION,
    pass,
    violence: scores.violence.score,
    frightening: scores.frightening.score,
    sexual: scores.sexual.score,
  }, 'Thumbnail safety verdict');
  return { version: THUMB_SAFETY_VERSION, pass, scores };
}

// Fetch a YouTube thumbnail variant (e.g. maxresdefault, hq1) and score it.
// A fetch failure or YouTube's placeholder image is a failing verdict.
export async function scoreYtThumbnailSafety(youtubeId: string, variant: string): Promise<ThumbSafetyVerdict> {
  const url = `https://i.ytimg.com/vi/${youtubeId}/${variant}.jpg`;
  let imageBase64: string;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength < YT_PLACEHOLDER_BYTES) throw new Error('placeholder-sized response');
    imageBase64 = Buffer.from(buf).toString('base64');
  } catch (err) {
    logger.warn({ err, youtubeId, variant, version: THUMB_SAFETY_VERSION }, 'Thumbnail safety: fetch failed — rejecting image');
    return failed('fetch_failed');
  }
  return scoreThumbnailSafety(imageBase64, { youtubeId, variant });
}
