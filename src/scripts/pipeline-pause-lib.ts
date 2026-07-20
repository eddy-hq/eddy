// Pure helpers for the pipeline-pause ops lever (ADR-0012). Extracted so the
// dual-path probe verdict and the parked-job selection are unit-testable
// without touching Redis, SSH, or yt-dlp.

// BullMQ job states clear-parked removes: everything queued-but-not-running.
// 'active' is deliberately excluded — a job mid-download must not be yanked
// out from under the worker.
export const REMOVABLE_PARKED_STATES = ['delayed', 'waiting', 'paused'] as const;

export function isRemovableParkedState(state: string): boolean {
  return (REMOVABLE_PARKED_STATES as readonly string[]).includes(state);
}

// Download jobs use the bare requestId as their jobId; restore jobs prefix it
// with `restore-`. Recover the underlying request_id from either form so
// clear-parked can find the owning requests row.
export function deriveRequestId(jobId: string): string {
  const prefix = 'restore-';
  return jobId.startsWith(prefix) ? jobId.slice(prefix.length) : jobId;
}

// Worker-path probe verdict. Success = ssh exit 0 AND yt-dlp emitted parseable
// JSON carrying a positive duration. `yt-dlp --dump-json` prints one JSON
// object per line; a single-video probe yields one line. A non-zero exit, no
// output, unparseable output, or a missing/non-positive duration all mean the
// download path is still blocked — stay paused.
export function parseWorkerProbe(exitCode: number | null, stdout: string): boolean {
  if (exitCode !== 0) return false;
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return false;
  try {
    const obj = JSON.parse(line) as { duration?: unknown };
    return typeof obj.duration === 'number' && obj.duration > 0;
  } catch {
    return false;
  }
}

// Both independent paths must be clear before resuming (ADR-0012): a clear
// anonymous M4 probe does not prove the worker's mweb+POT download path is
// clear, so either failure keeps the pipeline dark.
export function bothProbesClear(m4Clear: boolean, workerClear: boolean): boolean {
  return m4Clear && workerClear;
}
