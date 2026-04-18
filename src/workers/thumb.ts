import { promisify } from 'util';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from '../config';
import { logger as rootLogger } from '../logger';

const execFileAsync = promisify(execFile);

export async function generateThumbnail(
  youtubeId: string,
  filePath: string,
  durationSecs: number,
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

  if (fs.existsSync(thumbPath)) {
    return buildThumbUrl(youtubeId);
  }

  const seekSecs = Math.max(0, Math.floor(durationSecs * 0.25));
  const tmpJpg = path.join(os.tmpdir(), `eddy-thumb-${youtubeId}-${Date.now()}.jpg`);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(seekSecs),
      '-i', filePath,
      '-vf', 'thumbnail=300',
      '-frames:v', '1',
      '-f', 'image2',
      tmpJpg,
    ]);
  } catch (err) {
    log.warn({ err, youtubeId }, 'Thumbnail frame extraction failed');
    return null;
  }

  const srcWidth = config.EDDY_THUMB_SOURCE_WIDTH;
  const upscale = config.EDDY_THUMB_UPSCALE;
  const vf = `scale=${srcWidth}:-1:flags=area,scale=iw*${upscale}:-1:flags=neighbor`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', tmpJpg,
        '-vf', vf,
        '-q:v', '75',
        thumbPath,
      ]);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  try { fs.unlinkSync(tmpJpg); } catch { /* best-effort */ }

  if (lastErr) {
    log.warn({ err: lastErr, youtubeId }, 'Thumbnail stylisation failed after retry');
    return null;
  }

  return buildThumbUrl(youtubeId);
}

function buildThumbUrl(youtubeId: string): string | null {
  const nginxBase = config.NGINX_THUMB_BASE_URL;
  if (!nginxBase) return null;
  return `${nginxBase.replace(/\/$/, '')}/${youtubeId}.webp`;
}
