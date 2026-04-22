import 'dotenv/config';
import { promisify } from 'util';
import { execFile } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from '../config';

const execFileAsync = promisify(execFile);

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';

// Sample 5 positions evenly across the middle 60% of the video.
// Avoids intros / end cards that cluster near 0% and 100%.
const SEEK_FRACTIONS = [0.24, 0.36, 0.48, 0.60, 0.72];

const PROMPT = `Score this video frame 0-10 as a family-video thumbnail.

Judge by overall composition and visual impact. Penalise text/graphics only by how much of the frame they occupy — a small corner logo barely matters; a full-screen title card is disqualifying.

8-10: clear subject, strong composition, minor/no graphic intrusion.
4-7: decent but unremarkable, or graphics on a small portion of the frame.
0-3: dominated by text/graphics, transition, motion blur, washed out, near-black/white, no clear subject.

Return ONLY JSON: {"score": 0-10, "reason": "one short sentence, note if graphics are dominant or peripheral"}`;

interface FrameScore {
  seekSecs: number;
  score: number;
  reason: string;
  fileName: string | null; // relative to the video's output subdir
}

interface VideoRow {
  youtube_id: string;
  file_path: string;
  duration_secs: number;
}

interface VideoResult {
  row: VideoRow;
  scores: FrameScore[];
  elapsedSecs: number;
}

async function extractFrame(filePath: string, seekSecs: number, outPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y', '-ss', String(seekSecs),
    '-i', filePath,
    '-vf', 'scale=384:-2',
    '-frames:v', '1',
    '-f', 'image2',
    '-q:v', '3',
    outPath,
  ]);
}

function parseScore(raw: string): { score: number; reason: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    const preview = raw.trim().slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`No JSON in response — got: "${preview}"`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    const preview = match[0].slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Malformed JSON — got: "${preview}"`);
  }
  const score = parsed['score'];
  if (typeof score !== 'number' || score < 0 || score > 10) {
    throw new Error(`Invalid score: ${String(score)}`);
  }
  return {
    score,
    reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : '',
  };
}

function colourForScore(score: number): string {
  if (score < 0) return DIM;
  if (score >= 7) return GREEN;
  if (score >= 4) return YELLOW;
  return RED;
}

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function signBody(body: string): string {
  return `sha256=${crypto
    .createHmac('sha256', config.INTERNAL_HMAC_SECRET)
    .update(body)
    .digest('hex')}`;
}

async function scoreFrameViaM4(baseUrl: string, b64Image: string): Promise<string> {
  const body = JSON.stringify({ image: b64Image, prompt: PROMPT });
  const resp = await fetch(`${baseUrl}/internal/thumb/score-frame`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Eddy-Signature': signBody(body),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`score-frame HTTP ${resp.status}: ${await resp.text()}`);
  const { raw } = await resp.json() as { raw: string };
  return raw;
}

async function fetchVideos(ids: string[], recentCount: number): Promise<VideoRow[]> {
  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) throw new Error('M4_INTERNAL_URL not set — run this on the Ubuntu worker');

  const resp = await fetch(`${baseUrl}/internal/backfill/pending-thumbs?force=1`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Failed to fetch video list: HTTP ${resp.status}`);
  const { pending } = await resp.json() as { pending: VideoRow[] };

  if (ids.length === 0) return pending.slice(0, recentCount);

  const byId = new Map(pending.map((r) => [r.youtube_id, r]));
  const found: VideoRow[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) found.push(row);
    else missing.push(id);
  }
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.log(`${DIM}Not found: ${missing.join(', ')}${RESET}`);
  }
  return found;
}

async function scoreVideo(row: VideoRow, videoOutDir: string | null, baseUrl: string): Promise<FrameScore[]> {
  const tmpBase = videoOutDir ?? os.tmpdir();
  if (videoOutDir) fs.mkdirSync(videoOutDir, { recursive: true });

  const results: FrameScore[] = [];

  for (let i = 0; i < SEEK_FRACTIONS.length; i++) {
    const seekSecs = Math.max(0, Math.floor(row.duration_secs * SEEK_FRACTIONS[i]!));
    const fileName = `${String(i).padStart(2, '0')}-${fmtTime(seekSecs).replace(':', 'm')}s.jpg`;
    const framePath = videoOutDir
      ? path.join(tmpBase, fileName)
      : path.join(tmpBase, `eddy-frame-${row.youtube_id}-${Date.now()}-${fileName}`);

    try {
      await extractFrame(row.file_path, seekSecs, framePath);
      const buf = fs.readFileSync(framePath);
      const b64 = buf.toString('base64');
      const raw = await scoreFrameViaM4(baseUrl, b64);
      const parsed = parseScore(raw);
      results.push({
        seekSecs,
        score: parsed.score,
        reason: parsed.reason,
        fileName: videoOutDir ? fileName : null,
      });
    } catch (err) {
      results.push({ seekSecs, score: -1, reason: `ERROR: ${String(err).slice(0, 300)}`, fileName: null });
    } finally {
      if (!videoOutDir) {
        try { fs.unlinkSync(framePath); } catch { /* best-effort */ }
      }
    }
  }
  return results;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlScoreColour(score: number): string {
  if (score < 0) return '#888';
  if (score >= 7) return '#2a7';
  if (score >= 4) return '#c90';
  return '#c33';
}

function buildHtmlIndex(results: VideoResult[], runStamp: string): string {
  const sections = results.map((r) => {
    const valid = r.scores.filter((s) => s.score >= 0);
    const best = valid.length > 0 ? valid.reduce((a, b) => (a.score >= b.score ? a : b)) : null;

    const frames = r.scores.map((s) => {
      const isWinner = best && s === best;
      const colour = htmlScoreColour(s.score);
      const scoreStr = s.score < 0 ? 'ERR' : String(s.score);
      const imgTag = s.fileName
        ? `<img src="${escapeHtml(s.fileName)}" loading="lazy">`
        : `<div class="no-frame">frame not saved</div>`;
      return `
        <figure class="frame${isWinner ? ' winner' : ''}">
          ${imgTag}
          <figcaption>
            <span class="time">[${fmtTime(s.seekSecs)}]</span>
            <span class="score" style="color:${colour}">${scoreStr}</span>
            ${isWinner ? '<span class="winner-badge">winner</span>' : ''}
            <div class="reason">${escapeHtml(s.reason)}</div>
          </figcaption>
        </figure>`;
    }).join('\n');

    return `
      <section>
        <h2><code>${escapeHtml(r.row.youtube_id)}</code> <span class="meta">${fmtTime(r.row.duration_secs)} · ${r.elapsedSecs.toFixed(1)}s scored</span></h2>
        <div class="file-path">${escapeHtml(r.row.file_path)}</div>
        <div class="grid">${frames}</div>
      </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Eddy frame quality — ${escapeHtml(runStamp)}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; background: #111; color: #ddd; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 4px; }
  h2 .meta { color: #888; font-weight: normal; font-size: 13px; margin-left: 8px; }
  .file-path { color: #666; font-size: 12px; margin-bottom: 12px; word-break: break-all; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .frame { margin: 0; background: #1a1a1a; border-radius: 4px; overflow: hidden; border: 2px solid transparent; }
  .frame.winner { border-color: #2a7; box-shadow: 0 0 0 2px rgba(42,119,0,0.3); }
  .frame img { width: 100%; display: block; }
  .frame .no-frame { padding: 40px; text-align: center; color: #555; background: #222; }
  figcaption { padding: 8px 10px; }
  .time { color: #888; font-family: monospace; }
  .score { font-weight: bold; font-size: 16px; margin-left: 8px; font-family: monospace; }
  .winner-badge { background: #2a7; color: #000; font-size: 11px; padding: 1px 6px; border-radius: 3px; margin-left: 8px; vertical-align: middle; }
  .reason { color: #aaa; font-size: 12px; margin-top: 4px; }
  code { background: #222; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <h1>Eddy frame quality — ${escapeHtml(runStamp)}</h1>
  <div style="color:#888;font-size:12px;">${results.length} video(s) · ${SEEK_FRACTIONS.length} frames each</div>
  ${sections}
</body>
</html>
`;
}

async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
  const ids = rawArgs.filter((a) => !a.startsWith('--'));
  const keepFrames = flags.has('--keep');
  const recentCount = 5;

  const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = keepFrames
    ? path.join(config.THUMB_OUTPUT_PATH, `frame-test-${runStamp}`)
    : null;
  if (runDir) fs.mkdirSync(runDir, { recursive: true });

  const baseUrl = config.M4_INTERNAL_URL;
  if (!baseUrl) throw new Error('M4_INTERNAL_URL not set — run this on the Ubuntu worker');

  const videos = await fetchVideos(ids, recentCount);

  if (videos.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No videos to score.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${BOLD}Scoring ${videos.length} video(s) × ${SEEK_FRACTIONS.length} frames via M4 ${baseUrl}${RESET}` +
    (runDir ? `  ${DIM}(saving to ${runDir})${RESET}` : '') +
    '\n',
  );

  const startAll = Date.now();
  const results: VideoResult[] = [];

  for (const row of videos) {
    // eslint-disable-next-line no-console
    console.log(`${BOLD}${row.youtube_id}${RESET}  ${DIM}${truncate(row.file_path, 70)}  (${fmtTime(row.duration_secs)})${RESET}`);

    const videoOutDir = runDir ? path.join(runDir, row.youtube_id) : null;
    const t0 = Date.now();
    const scores = await scoreVideo(row, videoOutDir, baseUrl);
    const elapsedSecs = (Date.now() - t0) / 1000;
    results.push({ row, scores, elapsedSecs });

    const valid = scores.filter((s) => s.score >= 0);
    const best = valid.length > 0
      ? valid.reduce((a, b) => (a.score >= b.score ? a : b))
      : null;

    for (const s of scores) {
      const colour = colourForScore(s.score);
      const marker = best && s === best ? `  ${GREEN}← winner${RESET}` : '';
      const scoreStr = s.score < 0 ? 'ERR' : String(s.score).padStart(2);
      const reason = s.score < 0 ? s.reason : truncate(s.reason, 80);
      // eslint-disable-next-line no-console
      console.log(
        `  ${DIM}[${fmtTime(s.seekSecs).padStart(5)}]${RESET}  ` +
        `${colour}${scoreStr}${RESET}  ` +
        `${reason}${marker}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  ${DIM}${elapsedSecs.toFixed(1)}s${RESET}\n`);
  }

  const totalElapsed = ((Date.now() - startAll) / 1000).toFixed(1);

  if (runDir) {
    const html = buildHtmlIndex(results, runStamp);
    const indexPath = path.join(runDir, 'index.html');
    fs.writeFileSync(indexPath, html, 'utf8');

    const nginxBase = config.NGINX_THUMB_BASE_URL;
    const viewUrl = nginxBase
      ? `${nginxBase.replace(/\/$/, '')}/frame-test-${runStamp}/index.html`
      : `file://${indexPath}`;
    // eslint-disable-next-line no-console
    console.log(`${BOLD}Done${RESET} — ${totalElapsed}s total`);
    // eslint-disable-next-line no-console
    console.log(`${BOLD}View:${RESET} ${viewUrl}\n`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${BOLD}Done${RESET} — ${totalElapsed}s total  ${DIM}(pass --keep to save frames and get a browsable report)${RESET}\n`);
  }
}

run().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Script failed:', err);
  process.exit(1);
});
