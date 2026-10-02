// Shared types and pure helpers for the guard harness (brief §22, step 1).
//
// The harness freezes the parent's guard decisions into a dataset, replays
// them through a guard configuration, and scores the verdicts against the
// parent's labels. Everything it writes lives beside the DB under harness/,
// never in the repo, and everything it prints is counts and metrics only
// (ADR-0004).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EddyError } from '../../errors';
import type { ChannelHistory } from '../guard/index';

export class GuardHarnessError extends EddyError {
  constructor(message: string) {
    super(message, 'GUARD_HARNESS_ERROR');
    this.name = 'GuardHarnessError';
  }
}

export type GuardVerdictLabel = 'clear_yes' | 'clear_no' | 'uncertain';
export type HumanLabel = 'clear_yes' | 'clear_no';

// One parent decision, frozen with the inputs the guard would have seen when
// the parent decided. `itemId` is the decision id.
export interface HarnessItem {
  itemId: string;
  subjectType: 'candidate' | 'request';
  subjectId: string;
  userId: string;
  // The parent's current answer: the latest revision (#223), else the first
  // pass. `firstPassLabel` is the decision as first recorded, and `revisedAt`
  // when the latest revision was made (null if never revised).
  label: HumanLabel;
  firstPassLabel: HumanLabel;
  revisedAt: string | null;
  decisionSource: string;
  // RUBRIC_VERSION and the guard verdict the subject carried when decided.
  rubricVersion: string;
  guardVerdict: string | null;
  decidedAt: string;
  holdout: boolean;
  ageBand: string;
  title: string;
  channel: string | null;
  description: string | null;
  tags: string[];
  categoryId: string | null;
  madeForKids: boolean | null;
  ageRestricted: boolean;
  // History with the channel as it stood at decidedAt; null when the channel
  // is unknown, as the live guard leaves the line out.
  channelHistory: ChannelHistory | null;
}

// What an adapter returns for one item. `scores` and `probability` are
// optional: a verdict-only configuration (v3) carries neither.
export interface AdapterJudgement {
  verdict: GuardVerdictLabel;
  scores?: Record<string, number>;
  probability?: number;
}

// One guard configuration under test.
export interface HarnessAdapter {
  id: string;
  judge(item: HarnessItem): Promise<AdapterJudgement>;
}

// One cached result: ids, verdict and numbers only — never content.
export interface HarnessResult extends AdapterJudgement {
  adapterId: string;
  itemId: string;
  durationMs: number;
  evaluatedAt: string;
}

// Thrown by an adapter when the model never answered, so the runner retries
// the item on the next run rather than caching an error as a verdict.
export class AdapterScoringError extends GuardHarnessError {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterScoringError';
  }
}

// The brief's targets for a guard configuration (§9, Evaluation).
export const THRESHOLDS = {
  clearYesPrecision: 0.95,
  clearNoPrecision: 0.9,
  uncertainRate: { min: 0.1, max: 0.3 },
} as const;

// Share of decisions held out (never used as precedent; scored separately in
// the next slice).
export const HOLDOUT_PERCENT = 20;
const HOLDOUT_SALT = 'guard-harness-holdout-v1';

// FNV-1a, 32-bit.
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Fixed per decision id: the same decision is in or out of the holdout in
// every snapshot, whatever else the snapshot contains.
export function isHoldout(decisionId: string): boolean {
  return hash32(`${HOLDOUT_SALT}:${decisionId}`) % 100 < HOLDOUT_PERCENT;
}

// Discovery runs at these local times and keeps Ollama busy; a harness run
// would compete with it. [start, end) in minutes after local midnight.
export const DISCOVERY_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [5 * 60 + 45, 7 * 60],
  [9 * 60 + 45, 11 * 60],
  [13 * 60 + 45, 15 * 60],
];

export function inDiscoveryWindow(now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return DISCOVERY_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

// Harness files live beside the DB, e.g. ~/data/eddy/harness/.
export function harnessDir(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), 'harness');
}

export function datasetFileName(now: Date): string {
  return `dataset-${now.toISOString().slice(0, 10)}.jsonl`;
}

// Results are cached per dataset, so two datasets never mix: beside the
// dataset, named results-<full dataset file name>. Distinct dataset names
// always give distinct caches. A dataset may not itself be named results-*,
// or it could be another dataset's cache.
export function resultsPathFor(datasetPath: string): string {
  const name = path.basename(datasetPath);
  if (name.startsWith('results-')) {
    throw new GuardHarnessError(`${name} looks like a results cache, not a dataset`);
  }
  return path.join(path.dirname(datasetPath), `results-${name}`);
}

export function readJsonl<T>(file: string, parse: (raw: unknown, line: number) => T): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // A run killed mid-write leaves at most a torn last line.
      if (i === lines.length - 1 || lines.slice(i + 1).every((l) => !l.trim())) return;
      throw new GuardHarnessError(`${path.basename(file)} line ${i + 1} is not valid JSON`);
    }
    out.push(parse(raw, i + 1));
  });
  return out;
}

export function writeJsonl(file: string, rows: readonly unknown[]): void {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''), { flag: 'wx' });
}

// A run killed mid-write can leave a torn last line. Cut it off before
// appending, so the next row starts on a line of its own.
export function dropTornTail(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  if (text.length === 0 || text.endsWith('\n')) return;
  writeFileSync(file, text.slice(0, text.lastIndexOf('\n') + 1));
}

export function appendJsonl(file: string, row: unknown): void {
  appendFileSync(file, JSON.stringify(row) + '\n');
}

function isVerdictLabel(v: unknown): v is GuardVerdictLabel {
  return v === 'clear_yes' || v === 'clear_no' || v === 'uncertain';
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

export function parseHarnessItem(raw: unknown, line: number): HarnessItem {
  const bad = (field: string): never => {
    throw new GuardHarnessError(`Dataset line ${line} has an invalid ${field}`);
  };
  if (!isObject(raw)) return bad('shape');
  if (typeof raw['itemId'] !== 'string' || !raw['itemId']) bad('itemId');
  if (raw['label'] !== 'clear_yes' && raw['label'] !== 'clear_no') bad('label');
  if (typeof raw['title'] !== 'string') bad('title');
  if (typeof raw['ageBand'] !== 'string') bad('ageBand');
  if (typeof raw['holdout'] !== 'boolean') bad('holdout');
  if (!Array.isArray(raw['tags'])) bad('tags');
  const history = raw['channelHistory'];
  if (history !== null && !(isObject(history)
    && typeof history['approved'] === 'number' && typeof history['rejected'] === 'number')) {
    bad('channelHistory');
  }
  // Datasets frozen before revisions (#223) carry neither field: their label
  // is the first pass and was never revised.
  const firstPass = raw['firstPassLabel'];
  if (firstPass !== undefined && firstPass !== 'clear_yes' && firstPass !== 'clear_no') bad('firstPassLabel');
  const revisedAt = raw['revisedAt'];
  if (revisedAt !== undefined && revisedAt !== null && typeof revisedAt !== 'string') bad('revisedAt');
  return {
    ...raw,
    firstPassLabel: firstPass ?? raw['label'],
    revisedAt: revisedAt ?? null,
  } as unknown as HarnessItem;
}

export function parseHarnessResult(raw: unknown, line: number): HarnessResult {
  const bad = (field: string): never => {
    throw new GuardHarnessError(`Results line ${line} has an invalid ${field}`);
  };
  if (!isObject(raw)) return bad('shape');
  if (typeof raw['adapterId'] !== 'string' || !raw['adapterId']) bad('adapterId');
  if (typeof raw['itemId'] !== 'string' || !raw['itemId']) bad('itemId');
  if (!isVerdictLabel(raw['verdict'])) bad('verdict');
  return raw as unknown as HarnessResult;
}
