// Operational lever for YouTube IP-block incidents (first used 2026-05-31).
// Pauses BOTH the yt-dlp-touching queues — discovery (search + RSS poll +
// back-catalogue) and downloads (worker yt-dlp fetches) — so the residential IP
// goes fully quiet and the block can clear.
//
//   npx tsx src/scripts/pipeline-pause.ts pause            # quiet now
//   npx tsx src/scripts/pipeline-pause.ts status           # show paused flags
//   npx tsx src/scripts/pipeline-pause.ts resume           # force resume both
//   npx tsx src/scripts/pipeline-pause.ts resume-if-clear  # probe; resume only if IP is clear
//
// Pause persists in Redis, so it survives an M4/worker restart. Safe-fail
// direction is "stays paused": if a restart or a failed probe leaves it paused,
// nothing runs yt-dlp — you resume manually.
import 'dotenv/config';
import { discoveryQueue, downloadQueue, closeQueues } from '../queue';
import { videoDuration } from '../ytdlp';

// "Me at the zoo" — the first YouTube video, reliably available. A successful
// anonymous duration probe means the IP-wide bot block has lifted.
const PROBE_VIDEO = 'jNQXAC9IVRw';

async function pauseBoth(): Promise<void> {
  await discoveryQueue.pause();
  await downloadQueue.pause();
}

async function resumeBoth(): Promise<void> {
  await discoveryQueue.resume();
  await downloadQueue.resume();
}

async function statusLine(): Promise<string> {
  const [discovery, downloads] = await Promise.all([
    discoveryQueue.isPaused(),
    downloadQueue.isPaused(),
  ]);
  return `discovery paused=${discovery} | downloads paused=${downloads}`;
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status';

  if (action === 'pause') {
    await pauseBoth();
  } else if (action === 'resume') {
    await resumeBoth();
  } else if (action === 'resume-if-clear') {
    let clear = false;
    try {
      const secs = await videoDuration(PROBE_VIDEO);
      clear = secs > 0;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`probe failed — IP likely still blocked, staying paused: ${(err as Error).message}`);
    }
    if (clear) {
      await resumeBoth();
      // eslint-disable-next-line no-console
      console.log('probe clear — pipeline resumed');
    }
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
