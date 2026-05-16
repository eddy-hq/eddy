// One-off backfill: populate `file_size_bytes` for every `file_state = 'live'`
// row whose column is null, by stat-ing each video on the mediaserver via SSH.
// Rows whose file is missing on disk are flipped to `file_state = 'gone'`
// (status untouched) so downstream consumers stop counting them as live.
//
// Companion to migration 028 (#114). The worker captures file_size_bytes on
// every new download from now on; this script only needs to clean up the
// existing live rows that pre-date that change. Re-running is safe — the
// WHERE clause already excludes rows that are non-live or already sized.
//
// Usage: npm run backfill:file-size
import 'dotenv/config';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { logger } from '../logger';
import { config } from '../config';
import { markFileMissing } from '../modules/requests';

interface Row {
  request_id: string;
  file_path: string;
}

// stat exit-code conventions: 0 = found, 1 = missing on Linux GNU coreutils.
// We carry the raw size string back so the parent can distinguish "size
// returned" from "missing" without re-querying.
interface StatResult {
  filePath: string;
  sizeBytes: number | null; // null when stat reported missing (or unparseable)
  missing: boolean;
}

// Resolve a path that may begin with `~/` against the home dir. Node's
// child_process does no shell expansion on execFile-style args; the SSH key
// path comes from .env and is expected to use `~` by convention.
function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

interface SshTarget {
  user: string;
  host: string;
  key: string;
}

// Read the SSH target out of config and assert all three are set. Held in a
// script-local interface (not pushed back into config.ts) because nothing
// else in the runtime needs them — this is the only caller and a missing
// var here should be a clear ops error, not a server boot failure.
function resolveSshTarget(): SshTarget {
  const { VIDEO_SSH_USER, VIDEO_SSH_HOST, VIDEO_SSH_KEY } = config;
  const missing: string[] = [];
  if (!VIDEO_SSH_USER) missing.push('VIDEO_SSH_USER');
  if (!VIDEO_SSH_HOST) missing.push('VIDEO_SSH_HOST');
  if (!VIDEO_SSH_KEY) missing.push('VIDEO_SSH_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s) for backfill: ${missing.join(', ')}. ` +
        `See .env.example for the VIDEO_SSH_* block.`,
    );
  }
  return { user: VIDEO_SSH_USER!, host: VIDEO_SSH_HOST!, key: VIDEO_SSH_KEY! };
}

// Spawn ssh once with `xargs -0 stat -c '%n\0%s'` reading NUL-separated paths
// off stdin. One round-trip per chunk keeps the script under a few seconds
// even for several hundred rows, and the NUL framing tolerates any path
// content. Paths that don't exist make stat print to stderr and skip the
// stdout record — we reconcile by tracking which inputs got a stdout record.
function statRemote(target: SshTarget, filePaths: string[]): Promise<StatResult[]> {
  return new Promise((resolve, reject) => {
    const sshKey = expandHome(target.key);
    const sshArgs = [
      '-i', sshKey,
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${target.user}@${target.host}`,
      // -0 = NUL-separated; -r exits clean if no inputs; -n1 = one stat call
      // per path so a single missing file can't kill the whole batch (stat
      // exits non-zero for that path only). We pipe through `true` so the
      // remote shell exits 0 even when some stats fail.
      `xargs -0 -r -n1 stat -c '%n\\0%s\\n' 2>/dev/null; true`,
    ];

    const proc = spawn('ssh', sshArgs);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ssh exited ${code}: ${stderr.slice(0, 500)}`));
      }
      // Each stat record is `<path>\0<size>\n`. Multiple records concatenated.
      const sizeByPath = new Map<string, number>();
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const nulIdx = line.indexOf('\0');
        if (nulIdx === -1) continue;
        const p = line.slice(0, nulIdx);
        const sizeStr = line.slice(nulIdx + 1);
        const size = Number.parseInt(sizeStr, 10);
        if (!Number.isFinite(size)) continue;
        sizeByPath.set(p, size);
      }
      const results: StatResult[] = filePaths.map((p) => {
        const size = sizeByPath.get(p);
        if (size === undefined) return { filePath: p, sizeBytes: null, missing: true };
        return { filePath: p, sizeBytes: size, missing: false };
      });
      resolve(results);
    });

    // Write NUL-separated paths to stdin and close.
    proc.stdin.write(filePaths.join('\0'));
    proc.stdin.end();
  });
}

// Chunk size keeps an individual SSH round-trip's stdin/stdout buffers small
// and the failure blast radius narrow if the remote shell dies mid-batch.
const CHUNK_SIZE = 50;

async function run(): Promise<void> {
  runMigrations();

  const sshTarget = resolveSshTarget();

  const rows = db
    .prepare(
      `SELECT request_id, file_path
         FROM requests
        WHERE file_state = 'live'
          AND file_path IS NOT NULL
          AND file_size_bytes IS NULL
        ORDER BY downloaded_at`,
    )
    .all() as Row[];

  if (rows.length === 0) {
    logger.info('Backfill: nothing to do — every live row already has file_size_bytes');
    return;
  }

  logger.info(
    {
      total: rows.length,
      sshHost: sshTarget.host,
      sshUser: sshTarget.user,
      chunkSize: CHUNK_SIZE,
    },
    'Backfill: starting file_size_bytes backfill',
  );

  const updateSize = db.prepare(
    `UPDATE requests SET file_size_bytes = ? WHERE request_id = ?`,
  );

  let sized = 0;
  let missing = 0;
  let errored = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const paths = chunk.map((r) => r.file_path);

    let results: StatResult[];
    try {
      results = await statRemote(sshTarget, paths);
    } catch (err) {
      errored += chunk.length;
      logger.warn(
        { err, chunkStart: i, chunkSize: chunk.length },
        'Backfill: ssh stat chunk failed — skipping; re-run will retry',
      );
      continue;
    }

    for (let j = 0; j < chunk.length; j += 1) {
      const row = chunk[j]!;
      const result = results[j]!;
      if (result.missing) {
        const flipped = markFileMissing(row.request_id);
        missing += 1;
        logger.info(
          { requestId: row.request_id, filePath: row.file_path, flipped },
          'Backfill: file missing on disk — flipped file_state to gone',
        );
        continue;
      }
      if (result.sizeBytes === null) {
        errored += 1;
        continue;
      }
      updateSize.run(result.sizeBytes, row.request_id);
      sized += 1;
    }

    logger.info(
      { processed: Math.min(i + CHUNK_SIZE, rows.length), total: rows.length },
      'Backfill: chunk done',
    );
  }

  logger.info({ sized, missing, errored, total: rows.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
