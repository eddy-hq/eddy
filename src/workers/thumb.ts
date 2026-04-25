import { promisify } from 'util';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from '../config';
import { logger as rootLogger } from '../logger';
import { postSigned } from '../signed-channel';
import { parseOllamaJson } from '../ollama';

const execFileAsync = promisify(execFile);

// Sample 3 positions across the middle of the video. Used only when all YT
// options have classified as slop — rare in practice.
const LOCAL_SEEK_FRACTIONS = [0.30, 0.50, 0.70];

// Short-circuit local frame scoring on the first frame scoring at or above this.
const GOOD_ENOUGH_SCORE = 8;

// YT returns a ~1KB placeholder when a thumbnail variant doesn't exist.
const YT_PLACEHOLDER_THRESHOLD = 2000;

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

  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) {
    log.warn('M4_INTERNAL_URL not set — cannot classify, falling back to raw maxresdefault');
    return ytUrl(youtubeId, 'maxresdefault');
  }

  // Step 1: maxresdefault (cached at the M4 side after first call).
  try {
    const style = await classifyMaxresdefault(youtubeId);
    if (style === 'editorial') {
      log.info({ youtubeId }, 'maxresdefault editorial — using channel thumbnail');
      return ytUrl(youtubeId, 'maxresdefault');
    }
  } catch (err) {
    log.warn({ err }, 'maxresdefault classify failed — continuing to auto-frames');
  }

  // Step 2: YT auto-frames (1/2/3) — short-circuit on first editorial.
  for (const slot of YT_AUTO_FRAMES) {
    try {
      const style = await classifyVariant(youtubeId, slot.classifyVariant);
      if (style === 'editorial') {
        const display = await pickDisplayUrl(youtubeId, slot.displayVariant, slot.classifyVariant);
        log.info({ youtubeId, slot: slot.classifyVariant, display }, 'Auto-frame editorial — using YT URL');
        return display;
      }
    } catch (err) {
      log.warn({ err, slot: slot.classifyVariant }, 'Auto-frame classify failed — continuing');
    }
  }

  // Step 3: local fallback — extract 3 frames, score each, save raw WebP on first ≥ 8.
  if (!force && fs.existsSync(localThumbPath)) {
    log.debug('Local thumbnail already exists — reusing');
    return buildLocalThumbUrl(youtubeId);
  }

  const winner = await pickLocalFrame(youtubeId, filePath, durationSecs);
  if (winner) {
    try {
      fs.copyFileSync(winner.webpPath, localThumbPath);
      fs.unlinkSync(winner.webpPath);
      log.info({ youtubeId, seekSecs: winner.seekSecs, score: winner.score }, 'Saved local thumbnail');
      return buildLocalThumbUrl(youtubeId);
    } catch (err) {
      log.warn({ err }, 'Failed to save local thumbnail');
    }
  }

  // Final fallback: raw maxresdefault. User accepted this over a processed version.
  log.info({ youtubeId }, 'No usable local frame — falling back to raw maxresdefault');
  return ytUrl(youtubeId, 'maxresdefault');
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

async function pickDisplayUrl(youtubeId: string, preferred: string, fallback: string): Promise<string> {
  const url = ytUrl(youtubeId, preferred);
  try {
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    if (head.ok) {
      const len = parseInt(head.headers.get('content-length') ?? '0', 10);
      if (len >= YT_PLACEHOLDER_THRESHOLD) return url;
    }
  } catch { /* fall through */ }
  return ytUrl(youtubeId, fallback);
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

async function pickLocalFrame(
  youtubeId: string,
  filePath: string,
  durationSecs: number,
): Promise<LocalWinner | null> {
  const log = rootLogger.child({ youtubeId });
  const tmpBase = path.join(os.tmpdir(), `eddy-thumb-${youtubeId}-${Date.now()}`);
  const extracted: Array<{ path: string; seekSecs: number }> = [];

  // Extract all candidates up-front (cheap) so we can clean up whatever the scorer doesn't pick.
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

  let best: LocalWinner | null = null;
  for (const cand of extracted) {
    const b64 = fs.readFileSync(cand.path).toString('base64');
    const result = await scoreFrame(b64);
    if (result && (best === null || result.score > best.score)) {
      best = { webpPath: cand.path, seekSecs: cand.seekSecs, score: result.score };
    }
    if (result && result.score >= GOOD_ENOUGH_SCORE) {
      break; // short-circuit — this is good enough
    }
  }

  // Clean up every candidate except the eventual winner.
  for (const cand of extracted) {
    if (best && cand.path === best.webpPath) continue;
    try { fs.unlinkSync(cand.path); } catch { /* best-effort */ }
  }

  return best;
}
