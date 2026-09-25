// Re-run the parked backlog (Phase 6a). Kid candidates parked at
// `guard_pending` were judged by older candidate prompts on title + channel
// alone; this re-judges them with the stored Data API metadata the current
// candidate prompts read, under a chosen prompt (v3 verdict or v4 rubric).
//
// Two steps, so the model pass and the candidate_pool change are separable:
//   1. evaluateParkedBacklog — guards candidates and records the verdicts in
//      a results file. Writes guard_eval and video_metadata rows (via the
//      guard) but never candidate_pool.
//   2. applyParkedRerun — backs up the DB, then moves each still-parked row
//      per its recorded verdict, exactly as discovery's recheck would.
//
// For fast measurement the evaluation can draw a deterministic sample,
// stratified by kid, from either the parked backlog or from candidates the
// guard already decided (to check a new prompt doesn't flip an earlier
// clear_no into clear_yes), with a small bounded concurrency.
//
// The results file carries ids, verdicts, timings and rubric driver names
// only — never titles, channels, reasons or URLs (ADR-0004).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { db } from '../../db/client';
import { EddyError } from '../../errors';
import {
  GUARD_SCORING_ERROR_REASON,
  rerunVersionKey,
  driverCountKey,
  ensureVideoMetadata,
  type CandidatePromptId,
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

// 'pending': parked candidates (guard_pending). 'decided': candidates the
// guard already decided — scored (clear_yes) or guard_rejected (clear_no).
export type RerunPopulation = 'pending' | 'decided';

export interface ParkedRerunResult {
  candidateId: string;
  userId: string;
  oldVerdict: string | null;
  newVerdict: GuardVerdictValue;
  ageRestricted: boolean;
  evaluatedAt: string;
  promptVersion: string;
  population: RerunPopulation;
  // Wall time of the guard call in ms; null for the age-restricted
  // short-circuit (no model call) and for entries from older files.
  durationMs: number | null;
  // Rubric driver keys (v4), e.g. "over by 1: attitude". Null for v3.
  drivers: string[] | null;
}

const RESULT_KEYS: ReadonlyArray<keyof ParkedRerunResult> = [
  'candidateId', 'userId', 'oldVerdict', 'newVerdict', 'ageRestricted', 'evaluatedAt', 'promptVersion',
  'population', 'durationMs', 'drivers',
];

// Consecutive "model never answered" verdicts before the run stops. Ollama
// down or wedged would otherwise burn through the whole backlog writing error
// rows to guard_eval.
const MAX_CONSECUTIVE_SCORING_ERRORS = 5;

// Candidates added within this many days count as "recent" in the summary.
const RECENT_CANDIDATE_DAYS = 14;

// Ollama on the M4 is shared with live traffic; a handful of parallel calls
// at most.
export const MAX_RERUN_CONCURRENCY = 4;

// Fixed so two runs with the same population draw the same sample.
export const DEFAULT_SAMPLE_SEED = 1;

export interface RerunCandidateRow extends GuardableCandidate {
  user_id: string;
  guard_verdict: string | null;
}

// Every kid candidate currently parked for a parent. Adults' candidates are
// never guarded, so a guard_pending row on one would be stale state, not
// something to re-judge. Oldest first, so --limit trials a stable slice.
export function selectParkedCandidates(): RerunCandidateRow[] {
  return db.prepare(`
    SELECT cp.candidate_id, cp.user_id, cp.url, cp.title, cp.channel,
           cp.external_id, cp.guard_verdict
    FROM candidate_pool cp
    INNER JOIN users u ON u.user_id = cp.user_id
    WHERE cp.status = 'guard_pending' AND u.role = 'kid'
    ORDER BY cp.created_at ASC, cp.candidate_id ASC
  `).all() as RerunCandidateRow[];
}

// Kid candidates the guard already decided and that are still in that state:
// scored with clear_yes, or guard_rejected with clear_no. A scored row with
// no verdict hasn't been guarded yet and is left out.
export function selectDecidedCandidates(): RerunCandidateRow[] {
  return db.prepare(`
    SELECT cp.candidate_id, cp.user_id, cp.url, cp.title, cp.channel,
           cp.external_id, cp.guard_verdict
    FROM candidate_pool cp
    INNER JOIN users u ON u.user_id = cp.user_id
    WHERE u.role = 'kid'
      AND ((cp.status = 'scored' AND cp.guard_verdict = 'clear_yes')
        OR (cp.status = 'guard_rejected' AND cp.guard_verdict = 'clear_no'))
    ORDER BY cp.created_at ASC, cp.candidate_id ASC
  `).all() as RerunCandidateRow[];
}

// FNV-1a, for turning (seed, kid) into a PRNG seed.
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, deterministic.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic sample of up to `n` rows, stratified evenly by kid: each
// kid's rows are shuffled with a PRNG seeded from (seed, kid), then drawn
// round-robin across kids, so a kid with fewer rows than its share gives the
// rest to the others. Independent of the input order.
export function sampleCandidates<T extends { candidate_id: string; user_id: string }>(
  rows: readonly T[],
  n: number,
  seed: number = DEFAULT_SAMPLE_SEED,
): T[] {
  const byKid = new Map<string, T[]>();
  for (const r of rows) {
    const list = byKid.get(r.user_id) ?? [];
    list.push(r);
    byKid.set(r.user_id, list);
  }
  const kids = [...byKid.keys()].sort();
  const queues = kids.map((kid) => {
    const list = [...byKid.get(kid)!].sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0));
    const rand = prng(hash32(`${seed}:${kid}`));
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    return list;
  });
  const out: T[] = [];
  let depth = 0;
  while (out.length < n) {
    let took = false;
    for (const q of queues) {
      if (out.length >= n) break;
      const row = q[depth];
      if (row) {
        out.push(row);
        took = true;
      }
    }
    if (!took) break;
    depth += 1;
  }
  return out;
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
  // Fields added with the v4 tooling; absent in files written before it.
  const population = r['population'] ?? 'pending';
  if (population !== 'pending' && population !== 'decided') bad('population');
  const durationMs = r['durationMs'] ?? null;
  if (durationMs !== null && (typeof durationMs !== 'number' || !Number.isFinite(durationMs))) bad('durationMs');
  const drivers = r['drivers'] ?? null;
  if (drivers !== null && (!Array.isArray(drivers) || drivers.some((d) => typeof d !== 'string'))) bad('drivers');
  // Rebuild from the known keys so nothing else in the file is carried along.
  return {
    candidateId: r['candidateId'] as string,
    userId: r['userId'] as string,
    oldVerdict: r['oldVerdict'] as string | null,
    newVerdict: r['newVerdict'] as GuardVerdictValue,
    ageRestricted: r['ageRestricted'] as boolean,
    evaluatedAt: r['evaluatedAt'] as string,
    promptVersion: r['promptVersion'] as string,
    population: population as RerunPopulation,
    durationMs: durationMs as number | null,
    drivers: drivers as string[] | null,
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

// A drawn sample is saved beside the results file and reused by every later
// run with the same population, seed and size, so v3 and v4 are compared on
// the same videos even after the population has changed (new candidates
// arrive, rows are applied). Rows that have since left the population drop
// out and are counted; the sample is never topped up.
export function samplesPathFor(resultsPath: string): string {
  return resultsPath.replace(/\.json$/, '') + '.samples.json';
}

export function sampleKey(population: RerunPopulation, seed: number, n: number): string {
  return `${population}:seed=${seed}:n=${n}`;
}

function readSamples(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((id) => typeof id === 'string')) out[k] = v as string[];
    }
    return out;
  } catch {
    throw new ParkedRerunError(`Sample file is not valid JSON: ${path}`);
  }
}

function writeSamples(path: string, samples: Record<string, string[]>): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(samples, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface EvaluateParkedOptions {
  resultsPath: string;
  prompt: CandidatePromptId;
  population?: RerunPopulation;
  // Draw a deterministic, kid-stratified sample of this size from the
  // population before skipping already-evaluated candidates.
  sample?: number;
  seed?: number;
  // Evaluate at most this many not-yet-evaluated candidates this run.
  limit?: number;
  // Guard calls in flight at once, 1..MAX_RERUN_CONCURRENCY. Default 1.
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EvaluateParkedReport {
  promptVersion: string;
  population: RerunPopulation;
  // Size of the population (parked or decided), before sampling.
  eligible: number;
  // After sampling (equal to eligible without --sample).
  selected: number;
  // --sample only: whether the saved draw was reused, how many of its ids
  // have left the population since, and the ids (to scope the summary).
  sampleReused: boolean;
  sampleDropped: number;
  sampleIds: string[] | null;
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
  // Wall-clock seconds for the evaluation loop, and mean seconds per model
  // call this run (null when no model call was made).
  wallSeconds: number;
  meanCallSeconds: number | null;
}

// Guard every candidate in the chosen population (or a sample of it) not
// already in the results file at the chosen prompt version. Entries at other
// prompt versions stay in the file, so v3 and v4 results sit side by side.
// The results file is rewritten after every verdict, so a crash loses at
// most the calls in flight.
export async function evaluateParkedBacklog(opts: EvaluateParkedOptions): Promise<EvaluateParkedReport> {
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_RERUN_CONCURRENCY) {
    throw new ParkedRerunError(`Concurrency must be an integer from 1 to ${MAX_RERUN_CONCURRENCY}`);
  }
  const population = opts.population ?? 'pending';
  const promptVersion = rerunVersionKey(opts.prompt);

  const results = readRerunResults(opts.resultsPath);
  const done = new Set(results.filter((r) => r.promptVersion === promptVersion).map((r) => r.candidateId));

  const eligible = population === 'decided' ? selectDecidedCandidates() : selectParkedCandidates();
  let selected: RerunCandidateRow[] = eligible;
  let sampleReused = false;
  let sampleDropped = 0;
  let sampleIds: string[] | null = null;
  if (opts.sample !== undefined) {
    const seed = opts.seed ?? DEFAULT_SAMPLE_SEED;
    const samplesPath = samplesPathFor(opts.resultsPath);
    const samples = readSamples(samplesPath);
    const key = sampleKey(population, seed, opts.sample);
    const saved = samples[key];
    if (saved) {
      const byId = new Map(eligible.map((c) => [c.candidate_id, c]));
      selected = saved.map((id) => byId.get(id)).filter((c): c is RerunCandidateRow => c !== undefined);
      sampleReused = true;
      sampleDropped = saved.length - selected.length;
      sampleIds = saved;
    } else {
      selected = sampleCandidates(eligible, opts.sample, seed);
      sampleIds = selected.map((c) => c.candidate_id);
      samples[key] = sampleIds;
      writeSamples(samplesPath, samples);
    }
  }
  let todo = selected.filter((c) => !done.has(c.candidate_id));
  const alreadyEvaluated = selected.length - todo.length;
  if (opts.limit !== undefined) todo = todo.slice(0, opts.limit);

  const report: EvaluateParkedReport = {
    promptVersion,
    population,
    eligible: eligible.length,
    selected: selected.length,
    sampleReused,
    sampleDropped,
    sampleIds,
    alreadyEvaluated,
    attempted: 0,
    recorded: 0,
    scoringErrors: 0,
    abortedAfterErrors: false,
    missingMetadata: 0,
    wallSeconds: 0,
    meanCallSeconds: null,
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
  const bandFor = (userId: string): string => {
    let band = ageBands.get(userId);
    if (band === undefined) {
      band = getAgeBand(userId);
      ageBands.set(userId, band);
    }
    return band;
  };

  const started = Date.now();
  let callMs = 0;
  let calls = 0;
  let consecutiveErrors = 0;
  let next = 0;

  // A small worker pool: each worker takes the next candidate until the list
  // is done or the run aborts. Node is single-threaded, so the shared
  // counters and the results-file rewrite need no locking.
  const worker = async (): Promise<void> => {
    while (!report.abortedAfterErrors && next < guardable.length) {
      const c = guardable[next++]!;
      const t0 = Date.now();
      const { verdict, ageRestricted } = await guardCandidate(c, c.user_id, bandFor(c.user_id), metadata, opts.prompt);
      const durationMs = Date.now() - t0;
      report.attempted += 1;
      if (!ageRestricted) {
        calls += 1;
        callMs += durationMs;
      }

      if (verdict.reason === GUARD_SCORING_ERROR_REASON && verdict.confidence === 0) {
        report.scoringErrors += 1;
        consecutiveErrors += 1;
        opts.onProgress?.(report.attempted, guardable.length);
        if (consecutiveErrors >= MAX_CONSECUTIVE_SCORING_ERRORS) report.abortedAfterErrors = true;
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
        promptVersion,
        population,
        durationMs: ageRestricted ? null : durationMs,
        drivers: verdict.rubric ? verdict.rubric.decision.drivers.map(driverCountKey) : null,
      });
      writeRerunResults(opts.resultsPath, results);
      report.recorded += 1;
      opts.onProgress?.(report.attempted, guardable.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, guardable.length) }, () => worker()));

  report.wallSeconds = (Date.now() - started) / 1000;
  report.meanCallSeconds = calls > 0 ? callMs / calls / 1000 : null;
  return report;
}

export type TransitionCounts = Record<string, number>;

export interface ParkedRerunSummary {
  promptVersion: string;
  total: number;
  ageRestricted: number;
  transitions: TransitionCounts;
  // An earlier clear_no the new prompt would now surface. Called out on its
  // own: on the decided population this is the number that must stay at 0.
  clearNoToClearYes: number;
  // Keyed by placeholder (kid_1, kid_2, ...), never a user id or name.
  byUser: Record<string, TransitionCounts>;
  byCandidateAge: { recent: TransitionCounts; older: TransitionCounts; unknown: TransitionCounts };
  // --sample only: sample ids that have a result at another prompt version,
  // by version — shows the v3/v4 overlap the comparison rests on.
  otherVersions: Record<string, number>;
  // Rubric driver counts (v4): e.g. { "over by 1: attitude": 12 }. Empty for v3.
  drivers: Record<string, number>;
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

// Old → new verdict counts over one prompt version's results, overall, per
// kid placeholder, and split by how long the candidate has been in the pool;
// plus (v4) rubric driver counts. With `onlyIds` (a --sample run) it covers
// just the sample. No timing here: entries from runs at different concurrency
// aren't comparable, so the mean per call is reported per run instead.
export function summariseRerun(
  results: ParkedRerunResult[],
  promptVersion: string,
  now: Date = new Date(),
  onlyIds?: ReadonlySet<string>,
): ParkedRerunSummary {
  const inScope = onlyIds ? results.filter((r) => onlyIds.has(r.candidateId)) : results;
  const current = inScope.filter((r) => r.promptVersion === promptVersion);
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
    promptVersion,
    total: current.length,
    ageRestricted: 0,
    transitions: {},
    clearNoToClearYes: 0,
    byUser: {},
    byCandidateAge: { recent: {}, older: {}, unknown: {} },
    otherVersions: {},
    drivers: {},
  };
  if (onlyIds) {
    for (const r of inScope) {
      if (r.promptVersion !== promptVersion) bump(summary.otherVersions, r.promptVersion);
    }
  }
  for (const r of current) {
    const key = transitionKey(r);
    if (r.ageRestricted) summary.ageRestricted += 1;
    if (r.oldVerdict === 'clear_no' && r.newVerdict === 'clear_yes') summary.clearNoToClearYes += 1;
    bump(summary.transitions, key);
    const kid = placeholders.get(r.userId) ?? 'kid_unknown';
    bump(summary.byUser[kid] ??= {}, key);
    const created = createdAt.get(r.candidateId);
    const createdMs = created ? Date.parse(created) : Number.NaN;
    const bucket = Number.isNaN(createdMs) ? 'unknown' : createdMs >= recentCutoff ? 'recent' : 'older';
    bump(summary.byCandidateAge[bucket], key);
    for (const d of r.drivers ?? []) bump(summary.drivers, d);
  }
  return summary;
}

export interface ApplyParkedOptions {
  resultsPath: string;
  backupPath: string;
  // Only results at this prompt version are applied. The script passes the
  // live prompt's version unless --prompt was given explicitly.
  promptVersion: string;
  forceBackup?: boolean;
}

export interface ApplyParkedReport {
  results: number;
  promptVersion: string;
  // Results at another prompt version (or from the decided population);
  // not applied.
  otherVersion: number;
  // Candidates no longer guard_pending (or gone) since evaluation; not applied.
  statusChanged: number;
  applied: { scored: number; guard_rejected: number; guard_pending: number };
}

// Apply a results file to candidate_pool. Never calls the model. Backs up the
// DB first, then applies every verdict at the given prompt version whose
// candidate is still parked, in one transaction, via the same verdict →
// status mapping and update as discovery's recheck. Uncertain leaves the row
// parked.
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
    promptVersion: opts.promptVersion,
    otherVersion: 0,
    statusChanged: 0,
    applied: { scored: 0, guard_rejected: 0, guard_pending: 0 },
  };
  const readStatus = db.prepare('SELECT status FROM candidate_pool WHERE candidate_id = ?');

  db.transaction(() => {
    for (const r of results) {
      if (r.promptVersion !== opts.promptVersion || r.population !== 'pending') {
        report.otherVersion += 1;
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
