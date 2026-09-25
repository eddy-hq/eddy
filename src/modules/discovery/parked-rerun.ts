// Re-run the parked backlog (Phase 6a). Kid candidates parked at
// `guard_pending` were judged by older candidate prompts on title + channel
// alone; this re-judges them with the stored Data API metadata the current
// candidate prompt reads.
//
// Two steps, so the model pass and the candidate_pool change are separable:
//   1. evaluateParkedBacklog — guards every parked candidate serially and
//      records the verdicts in a results file. Writes guard_eval and
//      video_metadata rows (via the guard) but never candidate_pool.
//   2. applyParkedRerun — backs up the DB, then moves each still-parked row
//      per its recorded verdict, exactly as discovery's recheck would.
//
// The results file carries ids, verdicts and timestamps only — never titles,
// channels, reasons or URLs (ADR-0004).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { db } from '../../db/client';
import { EddyError } from '../../errors';
import {
  CANDIDATE_PROMPT_VERSION,
  GUARD_SCORING_ERROR_REASON,
  ensureVideoMetadata,
} from '../guard/index';
import { getAgeBand } from '../users';
import { guardCandidate, type GuardableCandidate } from './guard-candidate';
import { updateCandidatePoolStatus } from './surface';
import { statusForGuardVerdict, type GuardVerdictValue } from './util';

export class ParkedRerunError extends EddyError {
  constructor(message: string) {
    super(message, 'PARKED_RERUN_ERROR');
    this.name = 'ParkedRerunError';
  }
}

export interface ParkedRerunResult {
  candidateId: string;
  userId: string;
  oldVerdict: string | null;
  newVerdict: GuardVerdictValue;
  ageRestricted: boolean;
  evaluatedAt: string;
  promptVersion: string;
}

const RESULT_KEYS: ReadonlyArray<keyof ParkedRerunResult> = [
  'candidateId', 'userId', 'oldVerdict', 'newVerdict', 'ageRestricted', 'evaluatedAt', 'promptVersion',
];

// Consecutive "model never answered" verdicts before the run stops. Ollama
// down or wedged would otherwise burn through the whole backlog writing error
// rows to guard_eval.
const MAX_CONSECUTIVE_SCORING_ERRORS = 5;

// Candidates added within this many days count as "recent" in the summary.
const RECENT_CANDIDATE_DAYS = 14;

interface ParkedCandidateRow extends GuardableCandidate {
  user_id: string;
  guard_verdict: string | null;
}

// Every kid candidate currently parked for a parent. Adults' candidates are
// never guarded, so a guard_pending row on one would be stale state, not
// something to re-judge. Oldest first, so --limit trials a stable slice.
export function selectParkedCandidates(): ParkedCandidateRow[] {
  return db.prepare(`
    SELECT cp.candidate_id, cp.user_id, cp.url, cp.title, cp.channel,
           cp.external_id, cp.guard_verdict
    FROM candidate_pool cp
    INNER JOIN users u ON u.user_id = cp.user_id
    WHERE cp.status = 'guard_pending' AND u.role = 'kid'
    ORDER BY cp.created_at ASC, cp.candidate_id ASC
  `).all() as ParkedCandidateRow[];
}

function isVerdict(v: unknown): v is GuardVerdictValue {
  return v === 'clear_yes' || v === 'clear_no' || v === 'uncertain';
}

function parseResult(raw: unknown, index: number): ParkedRerunResult {
  const bad = (field: string): never => {
    throw new ParkedRerunError(`Results file entry ${index} has an invalid ${field}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('shape');
  const r = raw as Record<string, unknown>;
  if (typeof r['candidateId'] !== 'string' || !r['candidateId']) bad('candidateId');
  if (typeof r['userId'] !== 'string' || !r['userId']) bad('userId');
  if (r['oldVerdict'] !== null && typeof r['oldVerdict'] !== 'string') bad('oldVerdict');
  if (!isVerdict(r['newVerdict'])) bad('newVerdict');
  if (typeof r['ageRestricted'] !== 'boolean') bad('ageRestricted');
  if (typeof r['evaluatedAt'] !== 'string') bad('evaluatedAt');
  if (typeof r['promptVersion'] !== 'string') bad('promptVersion');
  // Rebuild from the known keys so nothing else in the file is carried along.
  return {
    candidateId: r['candidateId'] as string,
    userId: r['userId'] as string,
    oldVerdict: r['oldVerdict'] as string | null,
    newVerdict: r['newVerdict'] as GuardVerdictValue,
    ageRestricted: r['ageRestricted'] as boolean,
    evaluatedAt: r['evaluatedAt'] as string,
    promptVersion: r['promptVersion'] as string,
  };
}

// Read a results file. A missing file is an empty result set; a malformed one
// throws rather than being silently discarded.
export function readRerunResults(path: string): ParkedRerunResult[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ParkedRerunError(`Results file is not valid JSON: ${path}`);
  }
  if (!Array.isArray(parsed)) throw new ParkedRerunError(`Results file is not a JSON array: ${path}`);
  return parsed.map((raw, i) => parseResult(raw, i));
}

// Atomic replace: write a sibling temp file, then rename over the target, so
// a crash mid-write leaves the previous complete file in place.
export function writeRerunResults(path: string, results: ParkedRerunResult[]): void {
  const tmp = `${path}.tmp`;
  const clean = results.map((r) => Object.fromEntries(RESULT_KEYS.map((k) => [k, r[k]])));
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface EvaluateParkedOptions {
  resultsPath: string;
  // Evaluate at most this many not-yet-evaluated candidates this run.
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EvaluateParkedReport {
  parked: number;
  alreadyEvaluated: number;
  attempted: number;
  recorded: number;
  // Model calls that failed (Ollama error / unparseable output). Not written
  // to the results file, so the next run retries them.
  scoringErrors: number;
  abortedAfterErrors: boolean;
  // Candidates with no stored Data API metadata after the fetch. Not
  // evaluated and not written, so the next run retries them.
  missingMetadata: number;
}

// Guard every parked kid candidate not already in the results file at the
// current prompt version. Serial by design: Ollama on the M4 is shared with
// live traffic. The results file is rewritten after every verdict, so a crash
// loses at most the one in flight.
export async function evaluateParkedBacklog(opts: EvaluateParkedOptions): Promise<EvaluateParkedReport> {
  const existing = readRerunResults(opts.resultsPath);
  // Entries from an older prompt version are re-evaluated and replaced.
  const results = existing.filter((r) => r.promptVersion === CANDIDATE_PROMPT_VERSION);
  const done = new Set(results.map((r) => r.candidateId));

  const parked = selectParkedCandidates();
  let todo = parked.filter((c) => !done.has(c.candidate_id));
  const alreadyEvaluated = parked.length - todo.length;
  if (opts.limit !== undefined) todo = todo.slice(0, opts.limit);

  const report: EvaluateParkedReport = {
    parked: parked.length,
    alreadyEvaluated,
    attempted: 0,
    recorded: 0,
    scoringErrors: 0,
    abortedAfterErrors: false,
    missingMetadata: 0,
  };
  if (todo.length === 0) return report;

  // One metadata pass up front; ensureVideoMetadata chunks at 50 ids per
  // Data API call and never throws.
  const metadata = await ensureVideoMetadata(
    todo.map((c) => c.external_id).filter((id): id is string => !!id),
  );

  // The point of the re-run is the richer inputs. A candidate with no stored
  // metadata (fetch failed, quota hit, or the video is gone) would be judged
  // on title + channel again and then skipped by every later run, so leave it
  // out of the file and untouched — the next run tries the fetch again.
  const guardable = todo.filter((c) => c.external_id && metadata.has(c.external_id));
  report.missingMetadata = todo.length - guardable.length;

  const ageBands = new Map<string, string>();
  let consecutiveErrors = 0;
  for (const c of guardable) {
    let ageBand = ageBands.get(c.user_id);
    if (ageBand === undefined) {
      ageBand = getAgeBand(c.user_id);
      ageBands.set(c.user_id, ageBand);
    }

    const { verdict, ageRestricted } = await guardCandidate(c, c.user_id, ageBand, metadata);
    report.attempted += 1;

    if (verdict.reason === GUARD_SCORING_ERROR_REASON && verdict.confidence === 0) {
      report.scoringErrors += 1;
      consecutiveErrors += 1;
      opts.onProgress?.(report.attempted, guardable.length);
      if (consecutiveErrors >= MAX_CONSECUTIVE_SCORING_ERRORS) {
        report.abortedAfterErrors = true;
        break;
      }
      continue;
    }
    consecutiveErrors = 0;

    results.push({
      candidateId: c.candidate_id,
      userId: c.user_id,
      oldVerdict: c.guard_verdict,
      newVerdict: verdict.verdict,
      ageRestricted,
      evaluatedAt: new Date().toISOString(),
      promptVersion: CANDIDATE_PROMPT_VERSION,
    });
    writeRerunResults(opts.resultsPath, results);
    report.recorded += 1;
    opts.onProgress?.(report.attempted, guardable.length);
  }
  return report;
}

export type TransitionCounts = Record<string, number>;

export interface ParkedRerunSummary {
  total: number;
  ageRestricted: number;
  transitions: TransitionCounts;
  // Keyed by placeholder (kid_1, kid_2, ...), never a user id or name.
  byUser: Record<string, TransitionCounts>;
  byCandidateAge: { recent: TransitionCounts; older: TransitionCounts; unknown: TransitionCounts };
}

function bump(counts: TransitionCounts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function transitionKey(r: Pick<ParkedRerunResult, 'oldVerdict' | 'newVerdict'>): string {
  return `${r.oldVerdict ?? 'none'} -> ${r.newVerdict}`;
}

// Stable kid placeholders: oldest kid first, ties by id. Unknown ids (a user
// deleted since evaluation) get placeholders after the known kids.
function kidPlaceholders(userIds: string[]): Map<string, string> {
  const kids = db.prepare(`
    SELECT user_id FROM users WHERE role = 'kid'
    ORDER BY birth_year IS NULL, birth_year ASC, user_id ASC
  `).all() as { user_id: string }[];
  const out = new Map<string, string>();
  for (const k of kids) out.set(k.user_id, `kid_${out.size + 1}`);
  for (const id of [...new Set(userIds)].sort()) {
    if (!out.has(id)) out.set(id, `kid_${out.size + 1}`);
  }
  return out;
}

// Old → new verdict counts over the current-prompt results, overall, per kid
// placeholder, and split by how long the candidate has been in the pool.
export function summariseRerun(results: ParkedRerunResult[], now: Date = new Date()): ParkedRerunSummary {
  const current = results.filter((r) => r.promptVersion === CANDIDATE_PROMPT_VERSION);
  const createdAt = new Map<string, string>();
  if (current.length > 0) {
    const rows = db.prepare(`
      SELECT candidate_id, created_at FROM candidate_pool
      WHERE candidate_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(current.map((r) => r.candidateId))) as { candidate_id: string; created_at: string }[];
    for (const row of rows) createdAt.set(row.candidate_id, row.created_at);
  }
  const placeholders = kidPlaceholders(current.map((r) => r.userId));
  const recentCutoff = now.getTime() - RECENT_CANDIDATE_DAYS * 24 * 60 * 60 * 1000;

  const summary: ParkedRerunSummary = {
    total: current.length,
    ageRestricted: 0,
    transitions: {},
    byUser: {},
    byCandidateAge: { recent: {}, older: {}, unknown: {} },
  };
  for (const r of current) {
    const key = transitionKey(r);
    if (r.ageRestricted) summary.ageRestricted += 1;
    bump(summary.transitions, key);
    const kid = placeholders.get(r.userId) ?? 'kid_unknown';
    bump(summary.byUser[kid] ??= {}, key);
    const created = createdAt.get(r.candidateId);
    const createdMs = created ? Date.parse(created) : Number.NaN;
    const bucket = Number.isNaN(createdMs) ? 'unknown' : createdMs >= recentCutoff ? 'recent' : 'older';
    bump(summary.byCandidateAge[bucket], key);
  }
  return summary;
}

export interface ApplyParkedOptions {
  resultsPath: string;
  backupPath: string;
  forceBackup?: boolean;
}

export interface ApplyParkedReport {
  results: number;
  // Results from an older prompt version; not applied.
  staleVersion: number;
  // Candidates no longer guard_pending (or gone) since evaluation; not applied.
  statusChanged: number;
  applied: { scored: number; guard_rejected: number; guard_pending: number };
}

// Apply a results file to candidate_pool. Never calls the model. Backs up the
// DB first, then applies every current-prompt verdict whose candidate is
// still parked, in one transaction, via the same verdict → status mapping and
// update as discovery's recheck. Uncertain leaves the row parked.
export async function applyParkedRerun(opts: ApplyParkedOptions): Promise<ApplyParkedReport> {
  if (!existsSync(opts.resultsPath)) {
    throw new ParkedRerunError(`No results file at ${opts.resultsPath} — run the evaluation first`);
  }
  const results = readRerunResults(opts.resultsPath);

  if (existsSync(opts.backupPath)) {
    if (!opts.forceBackup) {
      throw new ParkedRerunError(
        `Backup already exists at ${opts.backupPath} — move it aside or pass --force-backup`,
      );
    }
    unlinkSync(opts.backupPath);
  }
  await db.backup(opts.backupPath);

  const report: ApplyParkedReport = {
    results: results.length,
    staleVersion: 0,
    statusChanged: 0,
    applied: { scored: 0, guard_rejected: 0, guard_pending: 0 },
  };
  const readStatus = db.prepare('SELECT status FROM candidate_pool WHERE candidate_id = ?');

  db.transaction(() => {
    for (const r of results) {
      if (r.promptVersion !== CANDIDATE_PROMPT_VERSION) {
        report.staleVersion += 1;
        continue;
      }
      const row = readStatus.get(r.candidateId) as { status: string } | undefined;
      if (row?.status !== 'guard_pending') {
        report.statusChanged += 1;
        continue;
      }
      const nextStatus = statusForGuardVerdict(r.newVerdict);
      updateCandidatePoolStatus(r.candidateId, r.newVerdict, nextStatus);
      report.applied[nextStatus] += 1;
    }
  })();

  return report;
}
