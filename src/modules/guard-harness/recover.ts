// Recover: fetch back the title and channel of decided candidates whose
// candidate_pool row has since been pruned, so the snapshot can keep them.
//
// Reads the DB on a read-only connection and calls the Data API's videos.list
// through the codebase's existing client (src/youtubeapi.ts: its key, its
// quota tally) in batches of 50. Writes harness/recovered-inputs.jsonl beside
// the DB, mode 0600, keyed by decision id. Content stays in that file: the
// result is counts only (ADR-0004).
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { openReadOnlyDatabase } from '../../db/read-only';
import {
  harnessDir,
  readRecoveredInputs,
  recoveredInputsPath,
  serialiseRecoveredInput,
  type RecoveredInput,
} from './util';

// videos.list takes at most 50 ids per call.
export const RECOVER_BATCH_SIZE = 50;

// What recover needs from a videos.list result. Ids the API omits (private,
// deleted, otherwise unavailable) are absent from the map.
export type FetchVideos = (ids: string[]) => Promise<Map<string, { title: string; channel: string; channelId: string }>>;

export interface MissingCandidate {
  decisionId: string;
  youtubeId: string | null;
}

export interface RecoverReport {
  recoveredPath: string;
  // Decided candidates with no candidate_pool row.
  missing: number;
  // Already in the recovered file and skipped (zero with --force).
  alreadyHad: number;
  // No YouTube id on the decision, so nothing to look up.
  noYoutubeId: number;
  // Fetched this run.
  recovered: number;
  // Looked up, but the API returned nothing: private, deleted or unavailable.
  unavailable: number;
  // Still to look up when a Data API error stopped the run (quota, network);
  // zero on a complete run. What was fetched before the error is saved.
  notAttempted: number;
  stoppedBy: { message: string; quotaExceeded: boolean } | null;
}

// Decided candidates whose candidate_pool row no longer exists. Same label
// filter as the snapshot.
export function selectMissingCandidates(source: Database): MissingCandidate[] {
  const rows = source.prepare(`
    SELECT d.decision_id, d.youtube_id
    FROM guard_decisions d
    LEFT JOIN candidate_pool cp ON cp.candidate_id = d.subject_id
    WHERE d.subject_type = 'candidate' AND cp.candidate_id IS NULL
      AND d.human_verdict IN ('clear_yes', 'clear_no')
    ORDER BY d.decided_at ASC, d.decision_id ASC
  `).all() as Array<{ decision_id: string; youtube_id: string | null }>;
  return rows.map((r) => ({ decisionId: r.decision_id, youtubeId: r.youtube_id?.trim() || null }));
}

// Write the whole file through a temporary one and a rename, mode 0600, so a
// run killed mid-write never leaves it torn and it is never world-readable.
function writeRecovered(file: string, rows: Iterable<RecoveredInput>): void {
  const tmp = `${file}.tmp`;
  const lines = [...rows].map((r) => JSON.stringify(serialiseRecoveredInput(r)));
  writeFileSync(tmp, lines.join('\n') + (lines.length > 0 ? '\n' : ''), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

async function defaultFetchVideos(): Promise<FetchVideos> {
  // Lazy: the Data API client loads config, which snapshot and report don't
  // need.
  const api = await import('../../youtubeapi');
  return api.fetchVideoMetadata;
}

// Recover inputs for every missing candidate not already recovered (all of
// them with `force`). Saves after each batch, so a quota error part-way keeps
// what was fetched; the run then stops and reports the error with the counts.
export async function recoverInputs(
  databasePath: string,
  opts: { force?: boolean; fetchVideos?: FetchVideos; now?: () => Date } = {},
): Promise<RecoverReport> {
  const source = openReadOnlyDatabase(databasePath);
  let missing: MissingCandidate[];
  try {
    missing = selectMissingCandidates(source);
  } finally {
    source.close();
  }

  const file = recoveredInputsPath(databasePath);
  const existing = readRecoveredInputs(file);
  const report: RecoverReport = {
    recoveredPath: file,
    missing: missing.length,
    alreadyHad: 0,
    noYoutubeId: 0,
    recovered: 0,
    unavailable: 0,
    notAttempted: 0,
    stoppedBy: null,
  };

  const todo: Array<{ decisionId: string; youtubeId: string }> = [];
  for (const m of missing) {
    if (!opts.force && existing.has(m.decisionId)) { report.alreadyHad += 1; continue; }
    if (!m.youtubeId) { report.noYoutubeId += 1; continue; }
    todo.push({ decisionId: m.decisionId, youtubeId: m.youtubeId });
  }
  if (todo.length === 0) return report;

  const fetchVideos = opts.fetchVideos ?? await defaultFetchVideos();
  const now = opts.now ?? (() => new Date());
  mkdirSync(harnessDir(databasePath), { recursive: true });

  // One lookup per distinct video; several decisions (one per kid) can share
  // a video.
  const ids = [...new Set(todo.map((t) => t.youtubeId))];
  const byVideo = new Map<string, Array<{ decisionId: string; youtubeId: string }>>();
  for (const t of todo) byVideo.set(t.youtubeId, [...(byVideo.get(t.youtubeId) ?? []), t]);

  for (let i = 0; i < ids.length; i += RECOVER_BATCH_SIZE) {
    const batch = ids.slice(i, i + RECOVER_BATCH_SIZE);
    let found: Awaited<ReturnType<FetchVideos>>;
    try {
      found = await fetchVideos(batch);
    } catch (err) {
      report.notAttempted = ids.slice(i).reduce((n, id) => n + (byVideo.get(id)?.length ?? 0), 0);
      report.stoppedBy = {
        message: err instanceof Error ? err.message : String(err),
        quotaExceeded: (err as { quotaExceeded?: unknown } | null)?.quotaExceeded === true,
      };
      return report;
    }
    const fetchedAt = now().toISOString();
    for (const id of batch) {
      const decisions = byVideo.get(id) ?? [];
      const video = found.get(id);
      if (!video || !video.title.trim()) {
        report.unavailable += decisions.length;
        continue;
      }
      for (const d of decisions) {
        existing.set(d.decisionId, {
          decisionId: d.decisionId,
          youtubeId: id,
          title: video.title,
          channel: video.channel,
          channelId: video.channelId,
          fetchedAt,
        });
        report.recovered += 1;
      }
    }
    writeRecovered(file, existing.values());
  }
  return report;
}
