import { promisify } from 'util';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from '../config';
import { logger as rootLogger } from '../logger';

const execFileAsync = promisify(execFile);

// Seek positions to try — spread across the middle of the video to avoid
// intros, end cards, and sponsored segments that cluster near 0% and 100%.
const SEEK_FRACTIONS = [0.20, 0.38, 0.55];

export async function generateThumbnail(
  youtubeId: string,
  filePath: string,
  durationSecs: number,
  { force = false } = {},
): Promise<string | null> {
  const log = rootLogger.child({ youtubeId });
  const thumbDir = config.THUMB_OUTPUT_PATH;
  const thumbPath = path.join(thumbDir, `${youtubeId}.webp`);

  try {
    fs.mkdirSync(thumbDir, { recursive: true });
  } catch (err) {
    log.warn({ err }, 'Failed to create thumb directory');
    return null;
  }

  if (!force && fs.existsSync(thumbPath)) {
    log.debug({ youtubeId }, 'Thumbnail already exists — skipping');
    return buildThumbUrl(youtubeId);
  }

  if (force && fs.existsSync(thumbPath)) {
    log.info({ youtubeId }, 'Force mode — regenerating existing thumbnail');
  }

  const sigma = config.EDDY_THUMB_BLUR_SIGMA;
  const saturation = config.EDDY_THUMB_SATURATION;
  const brightness = config.EDDY_THUMB_BRIGHTNESS;
  const vf = `gblur=sigma=${sigma},eq=saturation=${saturation}:brightness=${brightness}`;

  const base = path.join(os.tmpdir(), `eddy-thumb-${youtubeId}-${Date.now()}`);
  const candidates: string[] = [];

  for (let i = 0; i < SEEK_FRACTIONS.length; i++) {
    const seekSecs = Math.max(0, Math.floor(durationSecs * SEEK_FRACTIONS[i]));
    const tmpJpg  = `${base}-${i}.jpg`;
    const tmpWebp = `${base}-${i}.webp`;

    try {
      await execFileAsync('ffmpeg', [
        '-y', '-ss', String(seekSecs),
        '-i', filePath,
        '-vf', 'thumbnail=300',
        '-frames:v', '1',
        '-f', 'image2',
        tmpJpg,
      ]);
    } catch {
      continue;
    }

    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', tmpJpg,
        '-vf', vf,
        '-q:v', '75',
        tmpWebp,
      ]);
      candidates.push(tmpWebp);
    } catch {
      // this candidate failed — try the next
    } finally {
      try { fs.unlinkSync(tmpJpg); } catch { /* best-effort */ }
    }
  }

  if (candidates.length === 0) {
    log.warn({ youtubeId }, 'All candidate frames failed');
    return null;
  }

  // Pick the largest WebP — light/static frames compress small; varied content stays larger
  const best = candidates.reduce((a, b) =>
    fs.statSync(a).size >= fs.statSync(b).size ? a : b
  );

  log.debug({ youtubeId, candidates: candidates.length, winner: path.basename(best) }, 'Frame selected');

  fs.copyFileSync(best, thumbPath);
  for (const c of candidates) {
    try { fs.unlinkSync(c); } catch { /* best-effort */ }
  }

  return buildThumbUrl(youtubeId);
}

function buildThumbUrl(youtubeId: string): string | null {
  const nginxBase = config.NGINX_THUMB_BASE_URL;
  if (!nginxBase) return null;
  const v = Math.floor(Date.now() / 1000);
  return `${nginxBase.replace(/\/$/, '')}/${youtubeId}.webp?v=${v}`;
}
