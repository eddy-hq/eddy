// Operational lever for YouTube IP-block incidents (first used 2026-05-31).
// Pauses BOTH the yt-dlp-touching queues — discovery (search + RSS poll +
// back-catalogue) and downloads (worker yt-dlp fetches) — so the residential IP
// goes fully quiet and the block can clear.
//
//   npx tsx src/scripts/pipeline-pause.ts pause            # quiet now
//   npx tsx src/scripts/pipeline-pause.ts status           # show paused flags
//   npx tsx src/scripts/pipeline-pause.ts resume           # force resume both
//   npx tsx src/scripts/pipeline-pause.ts resume-if-clear  # dual-path probe; resume only if BOTH clear
//   npx tsx src/scripts/pipeline-pause.ts clear-parked     # drop parked download jobs, free their rows for re-selection
//
// Pause persists in Redis, so it survives an M4/worker restart. Safe-fail
// direction is "stays paused": if a restart or a failed probe leaves it paused,
// nothing runs yt-dlp — you resume manually.
//
// ADR-0012: resume is always manual and requires a DUAL-path probe — the M4
// anonymous path AND the worker's mweb+POT download path — because a clear
// anonymous probe does not prove the download path is clear. A resume also
// clears the escalating-cooldown and circuit-breaker Redis flags, so "resume"
// genuinely means "go now" rather than "un-pause but stay throttled".
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { discoveryQueue, downloadQueue, closeQueues, redis } from '../queue';
import { config } from '../config';
import { ipStackArgs } from '../ytdlp-ipstack';
import { videoDuration } from '../ytdlp';
import { db } from '../db/client';
import { getRequestsState } from '../modules/requests';
import { BOT_DETECTION_COOLDOWN_KEY, BOT_DETECTION_LEVEL_KEY } from '../botdetect';
import { deriveRequestId, parseWorkerProbe, bothProbesClear } from './pipeline-pause-lib';
import { resetCircuitBreaker, CIRCUIT_OPEN_KEY } from '../circuit-breaker';

// "Me at the zoo" — the first YouTube video, reliably available. A successful
// duration probe means the IP-wide bot block has lifted for that path.
const PROBE_VIDEO = 'jNQXAC9IVRw';

// The worker's download path is a different binary on a different host, so it
// can't be probed from the M4 process — SSH into the worker and run the same
// mweb+POT yt-dlp invocation the download path uses.
const WORKER_PROBE_HOST = 'eddy-mediaserver';
const WORKER_PROBE_CMD = [
  '~/.local/bin/yt-dlp',
  // Derived from the same config as the download path so the resume probe tests
  // the pinned IP stack, not an unpinned one.
  ...ipStackArgs(config.YTDLP_IP_STACK),
  '--js-runtimes node:node',
  '--remote-components ejs:github',
  '--extractor-args youtube:player_client=mweb',
  '--sleep-requests 1.5',
  '--dump-json',
  '--no-playlist',
  '--skip-download',
  '--no-write-playlist-metafiles',
  `https://www.youtube.com/watch?v=${PROBE_VIDEO}`,
].join(' ');

async function pauseBoth(): Promise<void> {
  await discoveryQueue.pause();
  await downloadQueue.pause();
}

async function resumeBoth(): Promise<void> {
  await discoveryQueue.resume();
  await downloadQueue.resume();
  // Clear the circuit-breaker open flag + escalation strikes so the pipeline
  // starts clean after a manual resume — otherwise the next arm would re-trip
  // instantly on inherited strikes (ADR-0012, change B).
  await resetCircuitBreaker();
}

// Drop the escalating-cooldown strike counter, its active cooldown, and the
// circuit-breaker flag so a manual resume starts from a clean slate. DEL of a
// missing key is a harmless no-op, so this is safe whether or not the breaker
// ever fired.
async function clearBlockState(): Promise<void> {
  await redis.del(BOT_DETECTION_COOLDOWN_KEY, BOT_DETECTION_LEVEL_KEY, CIRCUIT_OPEN_KEY);
}

async function statusLine(): Promise<string> {
  const [discovery, downloads] = await Promise.all([
    discoveryQueue.isPaused(),
    downloadQueue.isPaused(),
  ]);
  return `discovery paused=${discovery} | downloads paused=${downloads}`;
}

// M4 anonymous path probe. Reuses the plain-yt-dlp duration read discovery
// uses; a positive duration means the anonymous path is clear.
async function probeM4(): Promise<boolean> {
  try {
    const secs = await videoDuration(PROBE_VIDEO);
    const clear = secs > 0;
    // eslint-disable-next-line no-console
    console.log(`probe [M4 anonymous]: ${clear ? 'CLEAR' : 'blocked'} (duration=${secs})`);
    return clear;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`probe [M4 anonymous]: blocked — ${(err as Error).message}`);
    return false;
  }
}

// Worker mweb+POT path probe over SSH. Success = ssh exit 0 and parseable JSON
// with a positive duration.
function probeWorker(): boolean {
  const res = spawnSync('ssh', [WORKER_PROBE_HOST, WORKER_PROBE_CMD], {
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.log(`probe [worker mweb+POT]: blocked — ssh failed: ${res.error.message}`);
    return false;
  }
  const clear = parseWorkerProbe(res.status, res.stdout ?? '');
  if (clear) {
    // eslint-disable-next-line no-console
    console.log('probe [worker mweb+POT]: CLEAR');
  } else {
    const tail = (res.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
    // eslint-disable-next-line no-console
    console.log(`probe [worker mweb+POT]: blocked (exit=${res.status})${tail ? ` — ${tail}` : ''}`);
  }
  return clear;
}

// Remove parked (delayed/waiting/paused, never active) download jobs and move
// their still-'downloading' request rows to the non-destructive 'failed' state,
// resetting the owning candidate_pool row so the slate can re-select the video
// under budget (ADR-0012). No file was written for a parked job, so nothing is
// lost; 'failed' is retry-eligible and shown in the admin failures list.
//
// Order matters: the row is moved off 'downloading' BEFORE its job is removed,
// so the watchdog (which ignores non-'downloading' rows) can't re-enqueue it in
// the gap and resurrect the very burst this drains.
async function clearParked(): Promise<void> {
  const jobs = await downloadQueue.getJobs(['delayed', 'waiting', 'paused']);
  const state = getRequestsState();
  const readReq = db.prepare(
    'SELECT status, user_id, youtube_id FROM requests WHERE request_id = ?',
  );
  // Preserve guard_verdict so a kid's clear_yes survives the round-trip.
  const resetCandidate = db.prepare(`
    UPDATE candidate_pool
       SET status = 'scored', surfaced_date = NULL, surfaced_at = NULL
     WHERE user_id = ? AND external_id = ? AND status IN ('requested', 'surfaced')
  `);

  let removed = 0;
  let failedRows = 0;
  let resetCandidates = 0;
  let skipped = 0;

  for (const job of jobs) {
    const jobId = job.id;
    if (!jobId) continue;
    const requestId = (job.data?.requestId as string | undefined) ?? deriveRequestId(jobId);
    const row = readReq.get(requestId) as
      | { status: string; user_id: string; youtube_id: string | null }
      | undefined;

    if (row && row.status === 'downloading') {
      const { result } = state.apply({ kind: 'mark_failed', requestId });
      if (result.transitioned) {
        failedRows++;
        if (row.youtube_id) {
          const info = resetCandidate.run(row.user_id, row.youtube_id);
          if (info.changes > 0) resetCandidates++;
        }
      } else {
        skipped++;
      }
    } else {
      // Restore jobs, or rows already off 'downloading' — just drop the job to
      // keep the IP quiet; nothing to transition.
      skipped++;
    }

    try {
      await job.remove();
      removed++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`could not remove job ${jobId}: ${(err as Error).message}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `clear-parked: jobs removed=${removed} | rows→failed=${failedRows} | ` +
      `candidates→scored=${resetCandidates} | skipped(non-downloading)=${skipped}`,
  );
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status';

  if (action === 'pause') {
    await pauseBoth();
  } else if (action === 'resume') {
    await resumeBoth();
    await clearBlockState();
  } else if (action === 'resume-if-clear') {
    // Both paths must clear before resuming (ADR-0012). Run both regardless so
    // each outcome is logged, then decide.
    const m4Clear = await probeM4();
    const workerClear = probeWorker();
    if (bothProbesClear(m4Clear, workerClear)) {
      await resumeBoth();
      await clearBlockState();
      // eslint-disable-next-line no-console
      console.log('both probes clear — pipeline resumed, block state cleared');
    } else {
      // eslint-disable-next-line no-console
      console.log('at least one probe blocked — staying paused');
    }
  } else if (action === 'clear-parked') {
    await clearParked();
  }

  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${action}: ${await statusLine()}`);
  await closeQueues();
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
