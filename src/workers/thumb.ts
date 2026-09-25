import { promisify } from 'util';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { Logger } from 'pino';
import { config } from '../config';
import { logger as rootLogger } from '../logger';
import { postSigned } from '../signed-channel';
import { parseOllamaJson } from '../ollama';

const execFileAsync = promisify(execFile);

// Sample 3 positions across the middle of the video. Used only when no YT
// option is both editorial and safe.
const LOCAL_SEEK_FRACTIONS = [0.30, 0.50, 0.70];

// Short-circuit local frame scoring on the first frame scoring at or above this.
const GOOD_ENOUGH_SCORE = 8;

// YT returns a ~1KB placeholder when a thumbnail variant doesn't exist.
const YT_PLACEHOLDER_THRESHOLD = 2000;

// Safety floor (brief §6): every image the picker would show is scored by
// Gemma on Violence / Frightening / Sexual first. Each check is one Ollama
// call on the busy M4, so a video gets at most this many; once they're spent
// the picker stops and serves the placeholder. Four covers the creator
// thumbnail plus several fallbacks — a video whose first four candidates all
// fail is one to show neutrally anyway.
export const MAX_SAFETY_CHECKS = 4;

// Neutral image served when nothing passes the floor. Lives beside the frame
// thumbnails so nginx/Caddy serve it on the same path. The name is longer
// than an 11-character YouTube ID, so it can't collide with a video's frame.
export const PLACEHOLDER_FILENAME = '_neutral-placeholder.webp';
// Matches the PWA card background (THUMB_BG in Card.tsx).
const PLACEHOLDER_COLOUR = '0x0a0a0a';

// Slot labels for the YT auto-frame check. `classifyVariant` is sent to Gemma
// at a smaller resolution; `displayVariant` is the URL we actually serve.
const YT_AUTO_FRAMES: Array<{ classifyVariant: string; displayVariant: string }> = [
  { classifyVariant: 'hq1', displayVariant: 'maxres1' },
  { classifyVariant: 'hq2', displayVariant: 'maxres2' },
  { classifyVariant: 'hq3', displayVariant: 'maxres3' },
];

const SCORE_PROMPT = `Score this video frame 0-10 as a family-video thumbnail.

Judge by overall composition and visual impact. Penalise text/graphics only by how much of the frame they occupy — a small corner logo barely matters; a full-screen title card is disqualifying.

8-10: clear subject, strong composition, minor/no graphic intrusion.
4-7: decent but unremarkable, or graphics on a small portion of the frame.
0-3: dominated by text/graphics, transition, motion blur, washed out, near-black/white, no clear subject.

Return ONLY JSON: {"score": 0-10, "reason": "one short sentence"}`;

type SafetyTarget = { youtubeId: string; variant: string } | { image: string };

// Per-video safety bookkeeping: bounds the Ollama calls and feeds the summary
// log line (counts only — no titles, no model reasons).
class SafetyFloor {
  checks = 0;
  rejects = 0;

  constructor(private readonly log: Logger) {}

  get exhausted(): boolean {
    return this.checks >= MAX_SAFETY_CHECKS;
  }

  // True only on an explicit passing verdict. Budget spent, transport error,
  // non-2xx, or a malformed body all count as a fail (kid safety).
  async passes(target: SafetyTarget, slot: string): Promise<boolean> {
    if (this.exhausted) return false;
    this.checks++;
    let body: unknown;
    try {
      const resp = await postSigned('/internal/thumb/safety', target, { timeoutMs: 90_000 });
      body = await resp.json();
    } catch (err) {
      this.rejects++;
      this.log.warn({ err, slot }, 'Thumbnail safety check failed — treating image as unsafe');
      return false;
    }
    const pass = isPassingVerdict(body);
    if (!pass) {
      this.rejects++;
      this.log.info({ slot, ...verdictSummary(body) }, 'Thumbnail candidate failed safety floor');
    }
    return pass;
  }
}

const SAFETY_DIMENSIONS = ['violence', 'frightening', 'sexual'] as const;
const SAFETY_MAX_SCORE = 1;

// Re-checks the scores rather than trusting `pass` alone, so a malformed or
// partial response can never read as safe.
function isPassingVerdict(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b['pass'] !== true) return false;
  const scores = b['scores'];
  if (typeof scores !== 'object' || scores === null) return false;
  return SAFETY_DIMENSIONS.every((dim) => {
    const d = (scores as Record<string, unknown>)[dim];
    if (typeof d !== 'object' || d === null) return false;
    const score = (d as Record<string, unknown>)['score'];
    return typeof score === 'number' && score >= 0 && score <= SAFETY_MAX_SCORE;
  });
}

function verdictSummary(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;
  const scores = (typeof b['scores'] === 'object' && b['scores'] !== null ? b['scores'] : {}) as Record<string, { score?: unknown } | undefined>;
  return {
    version: b['version'],
    error: b['error'],
    violence: scores['violence']?.score,
    frightening: scores['frightening']?.score,
    sexual: scores['sexual']?.score,
  };
}

// Returns the URL to show for this video: an image that passed the safety
// floor, else the neutral placeholder. Null only when the placeholder can't be
// produced either — the caller then clears the thumbnail rather than leave an
// unchecked creator image in place. Never returns an unchecked image.
export async function generateThumbnail(
  youtubeId: string,
  filePath: string,
  durationSecs: number,
  { force = false } = {},
): Promise<string | null> {
  const log = rootLogger.child({ youtubeId });
  const thumbDir = config.THUMB_OUTPUT_PATH;
  const localThumbPath = path.join(thumbDir, `${youtubeId}.webp`);

  try {
    fs.mkdirSync(thumbDir, { recursive: true });
  } catch (err) {
    log.warn({ err }, 'Failed to create thumb directory');
  }

  const floor = new SafetyFloor(log);
  const done = (outcome: string, url: string | null): string | null => {
    log.info({ outcome, safetyChecks: floor.checks, safetyRejects: floor.rejects }, 'Thumbnail picked');
    return url;
  };

  if (!config.M4_INTERNAL_URL) {
    log.warn('M4_INTERNAL_URL not set — cannot safety-check, using placeholder');
    return done('placeholder', await placeholderThumbUrl(log));
  }

  // Step 1: creator thumbnail, if Gemma classes it editorial and it passes the floor.
  try {
    const style = await classifyMaxresdefault(youtubeId);
    if (style === 'editorial') {
      const variant = await pickDisplayVariant(youtubeId, 'maxresdefault', 'hqdefault');
      if (await floor.passes({ youtubeId, variant }, 'creator')) {
        return done('creator', ytUrl(youtubeId, variant));
      }
    }
  } catch (err) {
    log.warn({ err }, 'maxresdefault classify failed — continuing to auto-frames');
  }

  // Step 2: YT auto-frames (1/2/3) — first one that is editorial and passes the floor.
  for (const slot of YT_AUTO_FRAMES) {
    if (floor.exhausted) break;
    try {
      const style = await classifyVariant(youtubeId, slot.classifyVariant);
      if (style === 'editorial') {
        const variant = await pickDisplayVariant(youtubeId, slot.displayVariant, slot.classifyVariant);
        if (await floor.passes({ youtubeId, variant }, slot.classifyVariant)) {
          return done('auto-frame', ytUrl(youtubeId, variant));
        }
      }
    } catch (err) {
      log.warn({ err, slot: slot.classifyVariant }, 'Auto-frame classify failed — continuing');
    }
  }

  // Step 3: local frames. An existing local thumbnail (from an earlier run,
  // possibly before the floor existed) is re-checked, not trusted.
  if (!force && !floor.exhausted && fs.existsSync(localThumbPath)) {
    try {
      const b64 = fs.readFileSync(localThumbPath).toString('base64');
      if (await floor.passes({ image: b64 }, 'existing-local')) {
        const url = buildLocalThumbUrl(youtubeId);
        if (url) return done('existing-local', url);
      }
    } catch (err) {
      log.warn({ err }, 'Failed to read existing local thumbnail — extracting fresh frames');
    }
  }

  if (!floor.exhausted) {
    const winner = await pickLocalFrame(youtubeId, filePath, durationSecs, floor, log);
    if (winner) {
      try {
        fs.copyFileSync(winner.webpPath, localThumbPath);
        fs.unlinkSync(winner.webpPath);
        log.info({ seekSecs: winner.seekSecs, score: winner.score }, 'Saved local thumbnail');
        const url = buildLocalThumbUrl(youtubeId);
        if (url) return done('local-frame', url);
      } catch (err) {
        log.warn({ err }, 'Failed to save local thumbnail');
      }
    }
  }

  // Nothing passed (or checks ran out): neutral placeholder, never the
  // unchecked creator thumbnail.
  return done('placeholder', await placeholderThumbUrl(log));
}

// URL of the shared neutral placeholder, creating the file with ffmpeg on
// first use. Null when there's no thumb base URL or the file can't be made.
export async function placeholderThumbUrl(log: Logger = rootLogger): Promise<string | null> {
  const nginxBase = config.NGINX_THUMB_BASE_URL;
  if (!nginxBase) {
    log.warn('NGINX_THUMB_BASE_URL not set — no placeholder thumbnail available');
    return null;
  }
  const placeholderPath = path.join(config.THUMB_OUTPUT_PATH, PLACEHOLDER_FILENAME);
  if (!fs.existsSync(placeholderPath)) {
    // Write to a temp name then rename, so a concurrent reader never sees a
    // half-written file.
    const tmp = `${placeholderPath}.${process.pid}-${Date.now()}.tmp.webp`;
    try {
      fs.mkdirSync(config.THUMB_OUTPUT_PATH, { recursive: true });
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'lavfi',
        '-i', `color=c=${PLACEHOLDER_COLOUR}:s=640x360`,
        '-frames:v', '1',
        '-c:v', 'libwebp',
        tmp,
      ]);
      fs.renameSync(tmp, placeholderPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
      log.error({ err }, 'Failed to create placeholder thumbnail');
      return null;
    }
  }
  return `${nginxBase.replace(/\/$/, '')}/${PLACEHOLDER_FILENAME}`;
}

function ytUrl(youtubeId: string, variant: string): string {
  return `https://i.ytimg.com/vi/${youtubeId}/${variant}.jpg`;
}

function buildLocalThumbUrl(youtubeId: string): string | null {
  const nginxBase = config.NGINX_THUMB_BASE_URL;
  if (!nginxBase) return null;
  const v = Math.floor(Date.now() / 1000);
  return `${nginxBase.replace(/\/$/, '')}/${youtubeId}.webp?v=${v}`;
}

// The variant we'd actually serve: the preferred one if YouTube has a real
// image for it, else the fallback. The safety floor checks this variant, so
// the image checked is the image shown.
async function pickDisplayVariant(youtubeId: string, preferred: string, fallback: string): Promise<string> {
  try {
    const head = await fetch(ytUrl(youtubeId, preferred), { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    if (head.ok) {
      const len = parseInt(head.headers.get('content-length') ?? '0', 10);
      if (len >= YT_PLACEHOLDER_THRESHOLD) return preferred;
    }
  } catch { /* fall through */ }
  return fallback;
}

async function classifyMaxresdefault(youtubeId: string): Promise<'editorial' | 'slop'> {
  const resp = await postSigned('/internal/thumb/classify', { youtubeId }, { timeoutMs: 60_000 });
  const { style } = await resp.json() as { style: 'editorial' | 'slop' };
  return style;
}

async function classifyVariant(youtubeId: string, variant: string): Promise<'editorial' | 'slop'> {
  const resp = await postSigned('/internal/thumb/classify-variant', { youtubeId, variant }, { timeoutMs: 60_000 });
  const { style } = await resp.json() as { style: 'editorial' | 'slop' };
  return style;
}

async function scoreFrame(b64Image: string): Promise<{ score: number; reason: string } | null> {
  let raw: string;
  try {
    const resp = await postSigned('/internal/thumb/score-frame', { image: b64Image, prompt: SCORE_PROMPT }, { timeoutMs: 60_000 });
    ({ raw } = await resp.json() as { raw: string });
  } catch {
    return null;
  }
  return parseOllamaJson<{ score: number; reason: string }>(raw, 'object', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    const score = p['score'];
    if (typeof score !== 'number' || score < 0 || score > 10) return null;
    return {
      score,
      reason: typeof p['reason'] === 'string' ? p['reason'] : '',
    };
  });
}

interface LocalWinner {
  webpPath: string;
  seekSecs: number;
  score: number;
}

// Extract frames, score composition, and return the best-composed frame that
// passes the safety floor. A frame scoring ≥ GOOD_ENOUGH_SCORE is
// safety-checked straight away and, if it passes, ends scoring early.
async function pickLocalFrame(
  youtubeId: string,
  filePath: string,
  durationSecs: number,
  floor: SafetyFloor,
  log: Logger,
): Promise<LocalWinner | null> {
  const tmpBase = path.join(os.tmpdir(), `eddy-thumb-${youtubeId}-${Date.now()}`);
  const extracted: Array<{ path: string; seekSecs: number }> = [];

  // Extract all candidates up-front (cheap) so we can clean up whatever isn't picked.
  for (let i = 0; i < LOCAL_SEEK_FRACTIONS.length; i++) {
    const seekSecs = Math.max(0, Math.floor(durationSecs * LOCAL_SEEK_FRACTIONS[i]!));
    const tmpWebp = `${tmpBase}-${i}.webp`;
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-ss', String(seekSecs),
        '-i', filePath,
        '-vf', 'scale=640:-2',
        '-frames:v', '1',
        '-c:v', 'libwebp',
        '-q:v', '80',
        tmpWebp,
      ]);
      extracted.push({ path: tmpWebp, seekSecs });
    } catch {
      // this candidate failed — skip
    }
  }

  if (extracted.length === 0) {
    log.warn('All candidate frames failed to extract');
    return null;
  }

  let winner: LocalWinner | null = null;
  const checked = new Set<string>();
  const scored: LocalWinner[] = [];
  const b64Of = (p: string): string => fs.readFileSync(p).toString('base64');

  for (const cand of extracted) {
    const result = await scoreFrame(b64Of(cand.path));
    if (!result) continue;
    const entry = { webpPath: cand.path, seekSecs: cand.seekSecs, score: result.score };
    scored.push(entry);
    if (result.score >= GOOD_ENOUGH_SCORE && !floor.exhausted) {
      checked.add(entry.webpPath);
      if (await floor.passes({ image: b64Of(entry.webpPath) }, `frame-${entry.seekSecs}s`)) {
        winner = entry;
        break;
      }
    }
  }

  if (!winner) {
    const remaining = scored
      .filter((s) => !checked.has(s.webpPath))
      .sort((a, b) => b.score - a.score);
    for (const entry of remaining) {
      if (floor.exhausted) break;
      if (await floor.passes({ image: b64Of(entry.webpPath) }, `frame-${entry.seekSecs}s`)) {
        winner = entry;
        break;
      }
    }
  }

  // Clean up every candidate except the winner.
  for (const cand of extracted) {
    if (winner && cand.path === winner.webpPath) continue;
    try { fs.unlinkSync(cand.path); } catch { /* best-effort */ }
  }

  return winner;
}
