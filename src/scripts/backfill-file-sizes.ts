// One-off backfill (issue #114): populate `requests.file_size_bytes` for every
// `file_state = 'live'` row by stat-ing the file on the mediaserver via SSH.
// Rows whose file is missing on disk get flipped to `file_state = 'gone'` so
// the per-user recycler (#113) doesn't try to count or recycle them.
//
// Idempotent: re-running picks up where it left off — the SELECT excludes rows
// that already have a non-null `file_size_bytes` or have left `file_state =
// 'live'`. Safe to abort and restart at any point.
//
// SSH config follows the same env-var pattern as scripts/deploy.sh /
// scripts/watchdog.sh: VIDEO_SSH_USER / VIDEO_SSH_HOST / VIDEO_SSH_KEY, with
// the same Tailscale defaults so a vanilla run on the M4 just works.
//
// Why raw SQL for the gone-flip: the `requests` state machine has no event
// for `file_state: live → gone` independent of the soft-delete user-intent
// path (which also flips status to 'deleted'). A row whose file vanished from
// disk should keep its existing status; only the file_state column moves. A
// new event for this one-shot would be over-fitting.
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

interface Row {
  request_id: string;
  file_path: string;
}

const SSH_USER = process.env['VIDEO_SSH_USER'] ?? 'steveu';
const SSH_HOST = process.env['VIDEO_SSH_HOST'] ?? '100.95.170.27';
const SSH_KEY_RAW = process.env['VIDEO_SSH_KEY'] ?? `${os.homedir()}/.ssh/id_ed25519_eddy`;
// Tilde-expand if the env var was set with a literal `~` (matches
// scripts/deploy.sh:23 — same gotcha when the value comes from a shell var).
const SSH_KEY = SSH_KEY_RAW.startsWith('~/')
  ? `${os.homedir()}${SSH_KEY_RAW.slice(1)}`
  : SSH_KEY_RAW;

const SSH_OPTS = [
  '-i', SSH_KEY,
  '-o', 'ConnectTimeout=10',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
];

// Batch size for per-SSH-call stat. Big enough to amortise SSH handshake;
// small enough that an unexpectedly long argv stays well under ARG_MAX. The
// stat output format is a single line per file: "<size>\t<path>" on success
// or "MISSING\t<path>" on stat failure — easy to parse without a shell.
const BATCH_SIZE = 50;

interface StatResult {
  filePath: string;
  sizeBytes: number | null; // null means file is missing on disk
}

async function statBatch(filePaths: string[]): Promise<StatResult[]> {
  // `stat -c %s <path>` prints the size and exits 0 on success, non-zero on
  // missing file. Running stat under `sh -c` per-file inside a single SSH
  // invocation keeps every file independent — one missing path can't poison
  // the whole batch. The trailing `|| echo MISSING` flips a per-file failure
  // into a parseable "MISSING" token rather than a non-zero ssh exit.
  const remoteScript = filePaths
    .map((p) => {
      const escaped = p.replace(/'/g, `'\\''`);
      return `printf '%s\\t%s\\n' "$(stat -c %s '${escaped}' 2>/dev/null || echo MISSING)" '${escaped}'`;
    })
    .join('; ');

  const { stdout } = await execFileAsync(
    'ssh',
    [...SSH_OPTS, `${SSH_USER}@${SSH_HOST}`, remoteScript],
    { maxBuffer: 50 * 1024 * 1024, timeout: 60_000 },
  );

  const byPath = new Map<string, number | null>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) continue;
    const sizeToken = line.slice(0, tabIndex);
    const path = line.slice(tabIndex + 1);
    if (sizeToken === 'MISSING') {
      byPath.set(path, null);
    } else {
      const n = Number(sizeToken);
      byPath.set(path, Number.isFinite(n) && n >= 0 ? n : null);
    }
  }

  return filePaths.map((p) => ({ filePath: p, sizeBytes: byPath.get(p) ?? null }));
}

async function run(): Promise<void> {
  runMigrations();

  const rows = db.prepare(`
    SELECT request_id, file_path
      FROM requests
     WHERE file_state = 'live'
       AND file_path IS NOT NULL
       AND file_size_bytes IS NULL
     ORDER BY downloaded_at
  `).all() as Row[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — every live row with a file path already has file_size_bytes');
    return;
  }

  logger.info({ count: rows.length, host: SSH_HOST, user: SSH_USER }, 'Backfill: starting file-size backfill');

  // Update statements are prepared once and re-used per row. setBytes leaves
  // file_state alone; setGone clears the file pointer the same way the
  // soft-delete path does so a follow-up restore (#117) gets a clean slate.
  const setBytes = db.prepare(
    `UPDATE requests SET file_size_bytes = ? WHERE request_id = ? AND file_state = 'live'`,
  );
  const setGone = db.prepare(
    `UPDATE requests
        SET file_state = 'gone', file_path = NULL, nginx_url = NULL
      WHERE request_id = ? AND file_state = 'live'`,
  );

  let updated = 0;
  let flippedToGone = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    let stats: StatResult[];
    try {
      stats = await statBatch(batch.map((r) => r.file_path));
    } catch (err) {
      failed += batch.length;
      logger.warn({ err, batchStart: i, batchSize: batch.length }, 'Backfill: SSH stat batch failed — skipping');
      continue;
    }

    const byPath = new Map(stats.map((s) => [s.filePath, s.sizeBytes]));
    for (const row of batch) {
      const sizeBytes = byPath.get(row.file_path);
      if (sizeBytes === undefined) {
        // stat output didn't include this path — treat as failure but don't
        // touch the row, so a re-run will retry.
        failed += 1;
        logger.warn({ requestId: row.request_id, filePath: row.file_path }, 'Backfill: no stat line returned for path');
        continue;
      }
      if (sizeBytes === null) {
        setGone.run(row.request_id);
        flippedToGone += 1;
        logger.info({ requestId: row.request_id, filePath: row.file_path }, 'Backfill: file missing on mediaserver — flipped to gone');
      } else {
        setBytes.run(sizeBytes, row.request_id);
        updated += 1;
      }
    }

    logger.info(
      { processed: Math.min(i + BATCH_SIZE, rows.length), total: rows.length, updated, flippedToGone, failed },
      'Backfill: batch complete',
    );
  }

  logger.info({ updated, flippedToGone, failed, total: rows.length }, 'Backfill: file-size backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill: script failed');
  process.exit(1);
});
