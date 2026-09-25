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

// Neutral image served when nothing passes the floor, and as the interim
// thumbnail between download and the picker. An inline SVG (a dark 16:9
// rectangle in the PWA card background colour, THUMB_BG in Card.tsx), so it
// needs no file, no nginx and can't fail to exist — the thumbnail is never
// left null, which the PWA would fill with the creator's image.
export const PLACEHOLDER_THUMB_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%230a0a0a'/%3E%3C/svg%3E";

// Slot labels for the YT auto-frame check. `classifyVariant` is sent to Gemma
// at a smaller resolution for the style check; `displayVariant` is the image
// we'd show (falling back to `classifyVariant` where YT has no maxres).
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
  async passes(imageBase64: string, slot: string): Promise<boolean> {
    if (this.exhausted) return false;
    this.checks++;
    let body: unknown;
    try {
      const resp = await postSigned('/internal/thumb/safety', { image: imageBase64 }, { timeoutMs: 90_000 });
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

// Returns the URL to show for this video: a local copy of an image that
// passed the safety floor, else the neutral placeholder. Every winner — YT
// images included — is saved under THUMB_OUTPUT_PATH and served from there,
// so the bytes checked are the bytes shown; a YT URL would let the creator
// swap the image after it was checked. Never returns an unchecked image.
export async function generateThumbnail(
  youtubeId: string,
  filePath: string,
  durationSecs: number,
  { force = false } = {},
): Promise<string> {
  const log = rootLogger.child({ youtubeId });
  const thumbDir = config.THUMB_OUTPUT_PATH;
  const localThumbPath = path.join(thumbDir, `${youtubeId}.webp`);

  const floor = new SafetyFloor(log);
  const done = (outcome: string, url: string): string => {
    log.info({ outcome, safetyChecks: floor.checks, safetyRejects: floor.rejects }, 'Thumbnail picked');
    return url;
  };

  if (!config.M4_INTERNAL_URL) {
    log.warn('M4_INTERNAL_URL not set — cannot safety-check, using placeholder');
    return done('placeholder', PLACEHOLDER_THUMB_URL);
  }
  if (!config.NGINX_THUMB_BASE_URL) {
    log.warn('NGINX_THUMB_BASE_URL not set — cannot serve a checked image, using placeholder');
    return done('placeholder', PLACEHOLDER_THUMB_URL);
  }

  try {
    fs.mkdirSync(thumbDir, { recursive: true });
  } catch (err) {
    log.warn({ err }, 'Failed to create thumb directory');
  }

  // Stage a YT image locally, check it, and keep it if it passes.
  const tryYtImage = async (preferred: string, fallback: string, slot: string): Promise<string | null> => {
    const staged = await stageYtImage(youtubeId, preferred, fallback, log);
    if (!staged) return null;
    try {
      if (await floor.passes(fs.readFileSync(staged).toString('base64'), slot)) {
        return saveLocalThumb(staged, localThumbPath, youtubeId, log);
      }
      return null;
    } finally {
      try { fs.unlinkSync(staged); } catch { /* moved or already gone */ }
    }
  };

  // Step 1: creator thumbnail, if Gemma classes it editorial and it passes the floor.
  try {
    const style = await classifyMaxresdefault(youtubeId);
    if (style === 'editorial') {
      const url = await tryYtImage('maxresdefault', 'hqdefault', 'creator');
      if (url) return done('creator', url);
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
        const url = await tryYtImage(slot.displayVariant, slot.classifyVariant, slot.classifyVariant);
        if (url) return done('auto-frame', url);
      }
    } catch (err) {
      log.warn({ err, slot: slot.classifyVariant }, 'Auto-frame classify failed — continuing');
    }
  }

  // Step 3: local frames. An existing local thumbnail (from an earlier run,
  // possibly before the floor existed) is re-checked, not trusted.
  if (!force && !floor.exhausted && fs.existsSync(localThumbPath)) {
    try {
      if (await floor.passes(fs.readFileSync(localThumbPath).toString('base64'), 'existing-local')) {
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
      const url = saveLocalThumb(winner.webpPath, localThumbPath, youtubeId, log);
      if (url) {
        log.info({ seekSecs: winner.seekSecs, score: winner.score }, 'Saved local thumbnail');
        return done('local-frame', url);
      }
    }
  }

  // Nothing passed (or checks ran out): neutral placeholder, never the
  // unchecked creator thumbnail.
  return done('placeholder', PLACEHOLDER_THUMB_URL);
}

// Move a checked image into place as the video's local thumbnail. Copy then
// unlink rather than rename: the temp dir and the thumb dir may be on
// different filesystems.
function saveLocalThumb(srcPath: string, localThumbPath: string, youtubeId: string, log: Logger): string | null {
  try {
    fs.copyFileSync(srcPath, localThumbPath);
    fs.unlinkSync(srcPath);
    return buildLocalThumbUrl(youtubeId);
  } catch (err) {
    log.warn({ err }, 'Failed to save local thumbnail');
    return null;
  }
}

// Download a YT thumbnail variant (the preferred one if YT has a real image
// for it, else the fallback) and convert it to WebP in the temp dir. Returns
// the WebP path, or null if neither variant exists or conversion fails.
async function stageYtImage(youtubeId: string, preferred: string, fallback: string, log: Logger): Promise<string | null> {
  let bytes: Buffer | null = null;
  let variant = preferred;
  for (const v of [preferred, fallback]) {
    bytes = await fetchYtImage(youtubeId, v);
    if (bytes) { variant = v; break; }
  }
  if (!bytes) {
    log.info({ preferred, fallback }, 'YT thumbnail variant unavailable');
    return null;
  }
  const tmpBase = path.join(os.tmpdir(), `eddy-thumb-${youtubeId}-${variant}-${Date.now()}`);
  const jpg = `${tmpBase}.jpg`;
  const webp = `${tmpBase}.webp`;
  try {
    fs.writeFileSync(jpg, bytes);
    await execFileAsync('ffmpeg', ['-y', '-i', jpg, '-c:v', 'libwebp', '-q:v', '85', webp]);
    return webp;
  } catch (err) {
    log.warn({ err, variant }, 'Failed to convert YT thumbnail');
    try { fs.unlinkSync(webp); } catch { /* best-effort */ }
    return null;
  } finally {
    try { fs.unlinkSync(jpg); } catch { /* best-effort */ }
  }
}

async function fetchYtImage(youtubeId: string, variant: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(ytUrl(youtubeId, variant), { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.byteLength >= YT_PLACEHOLDER_THRESHOLD ? buf : null;
  } catch {
    return null;
  }
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
    // No safety checks left means no frame can be chosen — stop scoring.
    if (floor.exhausted) break;
    const result = await scoreFrame(b64Of(cand.path));
    if (!result) continue;
    const entry = { webpPath: cand.path, seekSecs: cand.seekSecs, score: result.score };
    scored.push(entry);
    if (result.score >= GOOD_ENOUGH_SCORE) {
      checked.add(entry.webpPath);
      if (await floor.passes(b64Of(entry.webpPath), `frame-${entry.seekSecs}s`)) {
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
      if (await floor.passes(b64Of(entry.webpPath), `frame-${entry.seekSecs}s`)) {
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
