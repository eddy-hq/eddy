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

// The remote bash one-liner emits exactly one record per input path so the
// parent can distinguish "remote command died entirely" (zero records, chunk
// retried) from "this specific file is missing" (explicit MISSING token).
// Without that distinction a broken pipeline could be mis-read as "every
// file is gone" and would flip live rows.
interface StatResult {
  filePath: string;
  sizeBytes: number | null; // present iff `kind === 'found'`
  kind: 'found' | 'missing';
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

// Spawn ssh once and run a small bash one-liner that emits exactly one record
// per NUL-separated input path:
//   - `<path>\0FOUND\0<bytes>\n` when stat -c '%s' succeeds
//   - `<path>\0MISSING\n` when stat fails (file absent, permission denied)
// One record per input means the parent can detect a wholly-failed chunk
// (zero records, or mismatched count) and skip it for retry, rather than
// mis-reading absence-of-output as "every file in the chunk is gone" and
// flipping live rows to gone on a broken pipeline.
//
// `set -eo pipefail` propagates real shell-setup failures (no bash, broken
// pipe to read) back as a non-zero exit code. The per-path branch swallows
// stat errors explicitly and emits MISSING — those are expected and must
// not abort the chunk.
function statRemote(target: SshTarget, filePaths: string[]): Promise<StatResult[]> {
  return new Promise((resolve, reject) => {
    const sshKey = expandHome(target.key);
    // The remote script reads NUL-separated paths and decides per path. Kept
    // inline (rather than scp'd) because it is small and ops-only. Uses bash
    // `read -d ''` to consume up to NUL.
    // Note on quoting: this whole string is passed as one arg to ssh, which
    // sends it to the remote shell which evaluates it. Stat's format string is
    // single-quoted so `%s` is literal; `printf` and `read` are bash
    // built-ins so the heredoc-style escapes here are bash-side, not host
    // shell. Stdin stays available for the path stream because `bash -c`
    // (which ssh invokes implicitly for a command) doesn't consume it.
    const remoteScript = `set -eo pipefail; while IFS= read -r -d '' p; do if size=$(stat -c '%s' -- "$p" 2>/dev/null); then printf '%s\\0FOUND\\0%s\\n' "$p" "$size"; else printf '%s\\0MISSING\\n' "$p"; fi; done`;
    const sshArgs = [
      '-i', sshKey,
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${target.user}@${target.host}`,
      remoteScript,
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
      const byPath = new Map<string, StatResult>();
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const parts = line.split('\0');
        const p = parts[0];
        const tag = parts[1];
        if (!p || !tag) continue;
        if (tag === 'FOUND') {
          const size = Number.parseInt(parts[2] ?? '', 10);
          if (!Number.isFinite(size)) continue;
          byPath.set(p, { filePath: p, sizeBytes: size, kind: 'found' });
        } else if (tag === 'MISSING') {
          byPath.set(p, { filePath: p, sizeBytes: null, kind: 'missing' });
        }
      }
      // If we got fewer records than inputs the remote pipeline didn't
      // complete cleanly — surface as a chunk failure so we don't flip
      // unreported paths to gone. Re-run picks them up.
      if (byPath.size !== filePaths.length) {
        return reject(new Error(
          `remote stat returned ${byPath.size} records for ${filePaths.length} inputs ` +
            `(stderr: ${stderr.slice(0, 200)})`,
        ));
      }
      const results: StatResult[] = filePaths.map((p) => {
        const r = byPath.get(p);
        // Belt-and-braces: byPath.size matches above, so this should never
        // hit. Treat as a chunk-level failure if it somehow does.
        if (!r) throw new Error(`internal: no record for ${p}`);
        return r;
      });
      resolve(results);
    });

    // NUL-terminate every record (including the last) so `read -d ''` on the
    // remote end consumes the final path before EOF closes stdin.
    proc.stdin.write(filePaths.map((p) => `${p}\0`).join(''));
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

  // Gate the size write on the row still being live + unsized. If a user
  // soft-deleted between the initial SELECT and this UPDATE the delete path
  // has already moved file_state to gone and nulled file_size_bytes; we
  // mustn't write the stale size back. `result.changes === 0` is normal in
  // that race, not an error — the row was correctly handled by the delete.
  const updateSize = db.prepare(
    `UPDATE requests SET file_size_bytes = ?
       WHERE request_id = ? AND file_state = 'live' AND file_size_bytes IS NULL`,
  );

  let sized = 0;
  let missing = 0;
  let raced = 0;
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
      if (result.kind === 'missing') {
        // markFileMissing is itself gated on file_state = 'live' so a row
        // that raced into 'gone' via soft-delete returns `false` and is a
        // safe no-op.
        const flipped = markFileMissing(row.request_id);
        missing += 1;
        logger.info(
          { requestId: row.request_id, filePath: row.file_path, flipped },
          'Backfill: file missing on disk — flipped file_state to gone',
        );
        continue;
      }
      const ranResult = updateSize.run(result.sizeBytes, row.request_id);
      if (ranResult.changes === 0) {
        raced += 1;
        continue;
      }
      sized += 1;
    }

    logger.info(
      { processed: Math.min(i + CHUNK_SIZE, rows.length), total: rows.length },
      'Backfill: chunk done',
    );
  }

  logger.info({ sized, missing, raced, errored, total: rows.length }, 'Backfill complete');
}

run().catch((err: unknown) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
