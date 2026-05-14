import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../logger';

const execFileAsync = promisify(execFile);

// Node binary for yt-dlp JS challenge solving (signature/n-challenge).
// Falls back to 'node' if not explicitly set — systemd PATH includes nvm bin dir.
const NODE_BIN = process.env['NODE_BIN'] ?? 'node';

// Args shared across all yt-dlp invocations.
// mweb client + bgutil PO token provider (bgutil-ytdlp-pot-provider pip plugin +
// HTTP server on 127.0.0.1:4416) handles bot-detection without cookies.
// node JS runtime handles signature/n-challenges.
function baseArgs(): string[] {
  return [
    '--js-runtimes', `node:${NODE_BIN}`,
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=mweb',
  ];
}

// Matches a single yt-dlp progress line: "[download]  45.2% of ~  2.34GiB ..."
const DOWNLOAD_PCT_RE = /^\[download\]\s+([\d.]+)%/;
// "[download] Destination: <path>" — emitted once per stream.
const DESTINATION_RE = /^\[download\]\s+Destination:/;
// Post-processing phases. yt-dlp prefixes vary by handler.
const POSTPROCESS_RE = /^\[(?:Merger|ExtractAudio|FixupM4a|ffmpeg|VideoConvertor|EmbedSubtitle|Metadata)\]/;

// Unified 0–99 progress scale. The worker bookends with 0 (job pickup) and
// 100 (file ready). Segments are heuristic — single-stream sources skip a
// band, accepting one jump rather than reweighting dynamically.
//
//   metadata fetch   0 →  5   (worker sets 5 once fetchMetadata returns)
//   video stream     5 → 60   (yt-dlp [download] % during stream 1)
//   audio stream    60 → 85   (yt-dlp [download] % during stream 2)
//   ffmpeg merge    85 → 99   (post-processor lines)
//   file on disk    100       (worker writes 100 after callback)
const SEG_DOWNLOAD_FLOOR = 5;
const SEG_VIDEO_CEIL = 60;
const SEG_AUDIO_CEIL = 85;
const SEG_MERGE_CEIL = 99;

export interface ProgressParser {
  feed(line: string): void;
}

/**
 * Build a stateful parser that translates yt-dlp's per-stream stdout into a
 * single monotonically non-decreasing percent on the unified scale above.
 * Caller drives it line-by-line; emissions are capped at 99 so the worker
 * owns the 100 transition.
 */
export function makeUnifiedProgressParser(onProgress?: (pct: number) => void): ProgressParser {
  let stream = 0; // 0 = none yet, 1 = video, 2 = audio
  let inMerge = false;
  let lastEmitted = 0;

  function emit(raw: number): void {
    const clamped = Math.min(SEG_MERGE_CEIL, Math.max(lastEmitted, Math.floor(raw)));
    if (clamped !== lastEmitted) {
      lastEmitted = clamped;
      onProgress?.(clamped);
    }
  }

  return {
    feed(rawLine: string): void {
      const line = rawLine.replace(/\r$/, '');

      if (DESTINATION_RE.test(line)) {
        stream = stream === 0 ? 1 : 2;
        emit(stream === 1 ? SEG_DOWNLOAD_FLOOR : SEG_VIDEO_CEIL);
        return;
      }

      if (POSTPROCESS_RE.test(line)) {
        if (!inMerge) {
          inMerge = true;
          emit(SEG_AUDIO_CEIL);
        }
        return;
      }

      // yt-dlp prints unprefixed "Deleting original file ..." lines after the
      // merger consumes the per-stream files — a reliable late-merge tick.
      if (inMerge && /Deleting original file/i.test(line)) {
        emit(SEG_MERGE_CEIL);
        return;
      }

      const m = line.match(DOWNLOAD_PCT_RE);
      if (m) {
        const pct = parseFloat(m[1]);
        if (stream <= 1) {
          emit(SEG_DOWNLOAD_FLOOR + (pct / 100) * (SEG_VIDEO_CEIL - SEG_DOWNLOAD_FLOOR));
        } else {
          emit(SEG_VIDEO_CEIL + (pct / 100) * (SEG_AUDIO_CEIL - SEG_VIDEO_CEIL));
        }
      }
    },
  };
}

export interface VideoMetadata {
  youtubeId: string;
  title: string;
  channel: string;
  youtubeChannelId: string | null;
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
  if (/premieres? in|premieres? on|this live event will begin|scheduled (start )?time/i.test(stderr)) {
    return "This one hasn't aired yet. Try again once it's live.";
  }
  // Bot detection is transient — return null so BullMQ retries with backoff
  if (/sign in to confirm|bot detection|please sign in/i.test(stderr)) {
    return null;
  }
  return null;
}

export async function fetchMetadata(url: string): Promise<VideoMetadata> {
  const { stdout, stderr } = await execFileAsync(config.YTDLP_BIN, [
    ...baseArgs(),
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    '--no-write-playlist-metafiles',
    url,
  ], { maxBuffer: 50 * 1024 * 1024 }).catch((err: NodeJS.ErrnoException & { stderr?: string }) => {
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

  // Gate currently-live broadcasts before downloadVideo can attach to the HLS
  // feed and pin a worker slot for the length of the stream. The worker reads
  // the `isLive` flag and parks the job in BullMQ's `delayed` state instead of
  // burning through retries, so the request stays quiet until the VOD lands.
  // is_upcoming is handled by mapYtdlpError's premiere match (terminal — could
  // be days away, no point polling).
  if (json['live_status'] === 'is_live') {
    const liveErr = new Error('Live broadcast in progress — will retry once the stream ends') as Error & { isLive: boolean };
    liveErr.isLive = true;
    throw liveErr;
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

  const rawChannelId = json['channel_id'];
  const youtubeChannelId = typeof rawChannelId === 'string' && rawChannelId.trim()
    ? rawChannelId
    : null;

  return {
    youtubeId: String(json['id'] ?? ''),
    title: String(json['title'] ?? ''),
    channel: String(json['uploader'] ?? json['channel'] ?? ''),
    youtubeChannelId,
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

  // Idempotent: if the file already exists (e.g. M4 rebooted mid-callback),
  // skip yt-dlp and return the path so the callback can be retried cheaply.
  try {
    const stat = fs.statSync(outputPath);
    if (stat.size > 0) {
      logger.info({ youtubeId, outputPath }, 'File already exists — skipping download');
      onProgress?.(100);
      return Promise.resolve(outputPath);
    }
  } catch {
    // file does not exist — proceed with download
  }

  logger.info({ youtubeId, outputPath }, 'Starting yt-dlp download');

  return new Promise((resolve, reject) => {
    const args = [
      ...baseArgs(),
      '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1]',
      '--concurrent-fragments', '4',
      '--write-auto-sub', '--sub-lang', 'en',
      '--no-part',
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '--sleep-interval', '5',
      '--max-sleep-interval', '10',
      '--newline',
      '--output', outputPath,
      url,
    ];

    const proc = spawn(config.YTDLP_BIN, args);
    const stderrChunks: Buffer[] = [];
    const parser = makeUnifiedProgressParser(onProgress);
    let stdoutTail = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutTail += chunk.toString();
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) parser.feed(line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on('close', (code) => {
      // Flush any final line that arrived without a trailing newline so its
      // progress signal isn't lost (e.g. a "Deleting original file" tick).
      if (stdoutTail) parser.feed(stdoutTail);
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
