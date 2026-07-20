import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../logger';
import { shouldEngageCooldown } from '../../botdetect';
import { uploadDateToIso } from '../../date';
import { ipStackArgs } from '../../ytdlp-ipstack';

const execFileAsync = promisify(execFile);

// An Error carrying a flag the worker reads off the rejection. `terminal` /
// `isLive` already follow this shape; `botDetection` joins them so the worker
// can engage the IP-wide cooldown (#185) on the way out without re-parsing
// stderr. It's armed for either throttle signal — a bot-detection challenge or
// a 429 (see shouldEngageCooldown) — not just the literal bot wall.
type FlaggedError = Error & { terminal?: boolean; isLive?: boolean; botDetection?: boolean };

// True once a BullMQ job has spent its entire retry budget. The worker reads
// this in its `failed` handler so it can own the terminal request transition on
// attempt-exhaustion (issue #183) — flipping the row off `downloading` itself
// rather than leaving it orphaned for the (unreliable, in-memory-counter)
// watchdog escalation to maybe rescue. BullMQ increments `attemptsMade` before
// emitting `failed`, so on the final attempt attemptsMade === attempts.
export function attemptsExhausted(attemptsMade: number, maxAttempts: number | undefined): boolean {
  return attemptsMade >= (maxAttempts ?? 1);
}

// Node binary for yt-dlp JS challenge solving (signature/n-challenge).
// Falls back to 'node' if not explicitly set — systemd PATH includes nvm bin dir.
const NODE_BIN = process.env['NODE_BIN'] ?? 'node';

// Args shared across all yt-dlp invocations.
// mweb client + bgutil PO token provider (bgutil-ytdlp-pot-provider pip plugin +
// HTTP server on 127.0.0.1:4416) handles bot-detection without cookies.
// node JS runtime handles signature/n-challenges.
function baseArgs(): string[] {
  return [
    // Pin the IP stack (default IPv4) so the worker download path shares one
    // reputation bucket with the M4 probe/metadata path (#185 follow-on).
    ...ipStackArgs(config.YTDLP_IP_STACK),
    '--js-runtimes', `node:${NODE_BIN}`,
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=mweb',
    // Space out the player-API/extraction HTTP calls (the ones that trip the
    // throttle), not the fragment transfer. Cheap politeness on the shared
    // residential IP; applies to every extraction pass.
    '--sleep-requests', '1.5',
  ];
}

// Where fetchMetadata parks the just-extracted info dict so downloadVideo can
// reuse it via --load-info-json instead of re-extracting (a second full player-
// API pass) on the same URL. Kept in the OS temp dir, NOT VIDEO_OUTPUT_PATH —
// cleanStaleIntermediates would otherwise delete it at download start.
function infoJsonPath(youtubeId: string): string {
  return path.join(os.tmpdir(), `eddy-info-${youtubeId}.json`);
}

// Best-effort removal of the cached info-json. Absent file (never written, or
// already cleaned) is the normal case, so swallow.
function cleanupInfoJson(youtubeId: string): void {
  if (!youtubeId) return;
  try {
    fs.unlinkSync(infoJsonPath(youtubeId));
  } catch {
    // never written / already gone — fine
  }
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
  // Video's own publish date (ISO 8601), captured from yt-dlp's `upload_date`.
  // Null when yt-dlp omits it or it can't be parsed — the UI falls back to
  // `requested_at` in that case (issue #186).
  publishedAt: string | null;
}

// Pull the ISO publish date out of a parsed yt-dlp `--dump-json` object.
// `upload_date` is `YYYYMMDD`; uploadDateToIso returns null for missing or
// malformed values, so a video yt-dlp can't date simply carries null through.
// Exported for unit testing without shelling out to yt-dlp.
export function extractPublishedAt(json: Record<string, unknown>): string | null {
  const raw = json['upload_date'];
  return typeof raw === 'string' ? uploadDateToIso(raw) : null;
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
  // Throttles (bot-detection challenge or 429) are transient — return null so
  // BullMQ retries with backoff. The worker also engages an IP-wide cooldown
  // (#185) so the retry parks in BullMQ's delayed state instead of hammering a
  // blocked IP. Detection itself lives in botdetect (single source of truth).
  if (shouldEngageCooldown(stderr)) {
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
    // Non-terminal: flag a throttle (bot-detection challenge or 429) so the
    // worker arms the cooldown (#185) before BullMQ retries. Still thrown (not
    // terminal) — the retry parks rather than hammering the block.
    if (shouldEngageCooldown(`${err.message ?? ''}\n${errOutput}`)) {
      (err as FlaggedError).botDetection = true;
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

  const youtubeId = String(json['id'] ?? '');

  // Cache the extracted info dict so downloadVideo can --load-info-json it
  // instead of running a second full extraction on the same URL. Written last,
  // after the live/terminal gates above, so we never leave a dangling cache for
  // a video that won't be downloaded. Best-effort: a write failure just means
  // downloadVideo re-extracts (the prior behaviour). `stdout` is exactly the
  // --write-info-json format --load-info-json expects.
  if (youtubeId) {
    try {
      fs.writeFileSync(infoJsonPath(youtubeId), stdout);
    } catch (err) {
      logger.debug({ err, youtubeId }, 'Could not cache info-json for download reuse');
    }
  }

  return {
    youtubeId,
    title: String(json['title'] ?? ''),
    channel: String(json['uploader'] ?? json['channel'] ?? ''),
    youtubeChannelId,
    description: String(json['description'] ?? '').slice(0, 2000),
    durationSecs: Number(json['duration'] ?? 0),
    transcript,
    publishedAt: extractPublishedAt(json),
  };
}

// Remove leftover format-specific pre-merge files (`<id>.fNNN.<ext>`), subtitle
// files, and other yt-dlp scratch artefacts for a given youtubeId. The final
// merged `<id>.mp4` is preserved — its presence is the idempotency signal.
//
// Why: on a failed download attempt yt-dlp leaves the per-format streams on
// disk. The next attempt sees them and tries to resume with a Range header;
// if YouTube has since rotated the format manifest (different byte count for
// the same format code) the server returns HTTP 416 and the job aborts.
// Without this cleanup the watchdog re-enqueues forever and never recovers.
export function cleanStaleIntermediates(outputDir: string, youtubeId: string): void {
  // Empty youtubeId would collapse the prefix to '.' and match every dotfile
  // (`.DS_Store`, etc.) in the output dir. Callers higher up should have
  // bailed before reaching here, but defend against it locally so a stray
  // empty value can't trash sibling files.
  if (!youtubeId) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(outputDir);
  } catch {
    return;
  }
  const prefix = `${youtubeId}.`;
  const finalName = `${youtubeId}.mp4`;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    if (name === finalName) continue;
    try {
      fs.unlinkSync(path.join(outputDir, name));
      logger.info({ youtubeId, file: name }, 'Removed stale yt-dlp intermediate');
    } catch (err) {
      logger.warn({ youtubeId, file: name, err }, 'Failed to remove stale intermediate');
    }
  }
}

// Assemble the yt-dlp download argv. `source` is the trailing positional: the
// cached info dict (`--load-info-json <path>`) or the watch URL.
function downloadArgs(outputPath: string, source: string[]): string[] {
  return [
    ...baseArgs(),
    '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1]',
    '--concurrent-fragments', '4',
    // No subtitle sidecar: the player mounts no <track> and nothing serves the
    // .vtt, so --write-auto-sub only wrote a file we delete — and it was the
    // one *fatal* subtitle fetch (a 429 on it exits yt-dlp 1, binning a good
    // video). The transcript we actually use is fetched separately from the
    // automatic_captions json3 URL, best-effort. So we don't fetch subs.
    '--no-part',
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--sleep-interval', '5',
    '--max-sleep-interval', '10',
    '--newline',
    '--output', outputPath,
    ...source,
  ];
}

// Run one yt-dlp download invocation to completion. Resolves on exit 0; rejects
// with a terminal Error (mapped kid-readable reason) or a FlaggedError
// (non-terminal; `botDetection` set on a throttle so the worker arms the
// cooldown). Stateless w.r.t. the info-json cache — downloadVideo owns that so
// it can retry with a different source.
function runYtDlpDownload(
  args: string[],
  youtubeId: string,
  outputPath: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
        // Non-terminal yt-dlp failure. Flag a throttle (bot-detection or 429) so
        // the worker arms the IP-wide cooldown (#185); the error is still
        // retryable, but the retry parks in delayed state rather than hammer the
        // block.
        const err = new Error(`yt-dlp exited with code ${code}\n${stderr}`) as FlaggedError;
        if (shouldEngageCooldown(stderr)) err.botDetection = true;
        return reject(err);
      }
      logger.info({ youtubeId, outputPath }, 'yt-dlp download complete');
      resolve();
    });

    proc.on('error', reject);
  });
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
      cleanupInfoJson(youtubeId);
      onProgress?.(100);
      return outputPath;
    }
  } catch {
    // file does not exist — proceed with download
  }

  cleanStaleIntermediates(outputDir, youtubeId);

  // Reuse the info dict fetchMetadata already extracted (in tmp, untouched by
  // cleanStaleIntermediates) so yt-dlp downloads from the cached formats instead
  // of running a second full extractor pass — halving the player-API hits per
  // download on the residential IP. The URLs are <1 min old, well inside their
  // expiry. Absent (write failed, or a future direct caller) → extract from the
  // URL exactly as before.
  const infoPath = infoJsonPath(youtubeId);
  const reuseInfoJson = fs.existsSync(infoPath);

  try {
    if (reuseInfoJson) {
      logger.info({ youtubeId, outputPath, reuseInfoJson: true }, 'Starting yt-dlp download');
      try {
        await runYtDlpDownload(downloadArgs(outputPath, ['--load-info-json', infoPath]), youtubeId, outputPath, onProgress);
        return outputPath;
      } catch (err) {
        const flagged = err as FlaggedError;
        // A terminal verdict (private/unavailable/age) is real, and a throttle
        // must stand the IP down — not retry into it. Only fall back when the
        // cached-info path failed for some other non-terminal reason (e.g. a
        // stale format URL → 403/416, or a video --load-info-json can't drive):
        // re-extract fresh from the URL once, inline, so a bad cache can't burn
        // the request's whole BullMQ retry budget. Clear partials first.
        if (flagged.terminal || flagged.botDetection) throw err;
        logger.warn({ youtubeId, err }, 'load-info-json download failed (non-terminal) — retrying via fresh URL extraction');
        cleanStaleIntermediates(outputDir, youtubeId);
      }
    }

    logger.info({ youtubeId, outputPath, reuseInfoJson: false }, 'Starting yt-dlp download');
    await runYtDlpDownload(downloadArgs(outputPath, [url]), youtubeId, outputPath, onProgress);
    return outputPath;
  } finally {
    // One cleanup point for every exit path (success, terminal, throttle,
    // fallback): the cache has served its purpose or the next BullMQ attempt
    // re-fetches a fresh one.
    cleanupInfoJson(youtubeId);
  }
}
