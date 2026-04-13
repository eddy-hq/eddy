import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../logger';

const execFileAsync = promisify(execFile);

const YTDLP_BIN = process.env['YTDLP_BIN'] ?? 'yt-dlp';

// Matches: [download]  45.2% of ~  2.34GiB at  5.67MiB/s ETA 03:12
const PROGRESS_RE = /\[download\]\s+([\d.]+)%/;

export interface VideoMetadata {
  youtubeId: string;
  title: string;
  channel: string;
  description: string;
  durationSecs: number;
  transcript: string | null;
}

// Maps yt-dlp error output to kid-readable rejection reasons.
// Returns null if the error is not a known terminal failure (i.e. worth retrying).
export function mapYtdlpError(stderr: string): string | null {
  if (/age.?restrict/i.test(stderr)) {
    return "This one's age-restricted on YouTube. Ask a grown-up?";
  }
  if (/private video|video is private/i.test(stderr)) {
    return "This video is private.";
  }
  if (/video unavailable|has been removed|no longer available/i.test(stderr)) {
    return "This video isn't available any more.";
  }
  if (/geo.?block|not available in your country/i.test(stderr)) {
    return "This video isn't available in your region.";
  }
  if (/members.?only|join this channel/i.test(stderr)) {
    return "This video is for channel members only.";
  }
  return null;
}

export async function fetchMetadata(url: string): Promise<VideoMetadata> {
  const { stdout, stderr } = await execFileAsync(YTDLP_BIN, [
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    '--no-write-playlist-metafiles',
    url,
  ]).catch((err: NodeJS.ErrnoException & { stderr?: string }) => {
    const errOutput = err.stderr ?? '';
    const reason = mapYtdlpError(errOutput);
    if (reason) {
      const terminalErr = new Error(reason) as Error & { terminal: boolean };
      terminalErr.terminal = true;
      throw terminalErr;
    }
    throw err;
  });

  if (stderr) {
    logger.debug({ url }, 'yt-dlp metadata stderr (non-fatal)');
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error('yt-dlp returned invalid JSON for metadata');
  }

  // Extract auto-subtitle text if present (best-effort; null is fine)
  let transcript: string | null = null;
  const subtitles = json['automatic_captions'] as Record<string, unknown> | undefined;
  if (subtitles && subtitles['en']) {
    const enSubs = subtitles['en'] as Array<{ ext?: string; url?: string }>;
    const jsonSub = enSubs.find((s) => s.ext === 'json3');
    if (jsonSub?.url) {
      try {
        const resp = await fetch(jsonSub.url);
        const subJson = await resp.json() as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
        transcript = subJson.events
          ?.flatMap((e) => e.segs ?? [])
          .map((s) => s.utf8 ?? '')
          .join('')
          .replace(/\n/g, ' ')
          .trim() ?? null;
      } catch {
        // subtitle fetch is best-effort; proceed without
      }
    }
  }

  return {
    youtubeId: String(json['id'] ?? ''),
    title: String(json['title'] ?? ''),
    channel: String(json['uploader'] ?? json['channel'] ?? ''),
    description: String(json['description'] ?? '').slice(0, 2000),
    durationSecs: Number(json['duration'] ?? 0),
    transcript,
  };
}

export async function downloadVideo(
  youtubeId: string,
  url: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const outputDir = config.VIDEO_OUTPUT_PATH;
  const outputPath = path.join(outputDir, `${youtubeId}.mp4`);

  logger.info({ youtubeId, outputPath }, 'Starting yt-dlp download');

  return new Promise((resolve, reject) => {
    const args = [
      '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1]',
      '--concurrent-fragments', '4',
      '--write-auto-sub', '--sub-lang', 'en',
      '--no-part',
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '--extractor-args', 'youtube:player_client=default,mweb',
      '--newline',
      '--output', outputPath,
      url,
    ];

    const proc = spawn(YTDLP_BIN, args);
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const m = line.match(PROGRESS_RE);
        if (m && onProgress) {
          onProgress(Math.floor(parseFloat(m[1])));
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        const reason = mapYtdlpError(stderr);
        if (reason) {
          const err = new Error(reason) as Error & { terminal: boolean };
          err.terminal = true;
          return reject(err);
        }
        return reject(new Error(`yt-dlp exited with code ${code}\n${stderr}`));
      }
      logger.info({ youtubeId, outputPath }, 'yt-dlp download complete');
      resolve(outputPath);
    });

    proc.on('error', reject);
  });
}
