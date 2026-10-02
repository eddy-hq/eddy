// Runner: replay a dataset through one adapter. Resumable — results are
// appended to a JSONL cache as each item finishes, keyed by (adapterId,
// itemId), and items already cached are skipped. One call at a time by
// default: Ollama on the M4 is shared with live traffic.
import {
  AdapterScoringError,
  appendJsonl,
  dropTornTail,
  inDiscoveryWindow,
  parseHarnessResult,
  readJsonl,
  GuardHarnessError,
  type HarnessAdapter,
  type HarnessItem,
  type HarnessResult,
} from './util';

// Consecutive model failures before the run stops: Ollama down or wedged.
const MAX_CONSECUTIVE_ERRORS = 5;
export const MAX_CONCURRENCY = 4;

export interface RunOptions {
  items: readonly HarnessItem[];
  adapter: HarnessAdapter;
  resultsPath: string;
  limit?: number;
  concurrency?: number;
  force?: boolean;
  now?: () => Date;
  onProgress?: (done: number, total: number) => void;
}

export interface RunReport {
  datasetItems: number;
  alreadyEvaluated: number;
  selected: number;
  evaluated: number;
  scoringErrors: number;
  abortedAfterErrors: boolean;
  meanCallMs: number | null;
}

export function readResults(resultsPath: string): HarnessResult[] {
  return readJsonl(resultsPath, parseHarnessResult);
}

export function resultKey(adapterId: string, itemId: string): string {
  return `${adapterId}\u0000${itemId}`;
}

export async function runHarness(opts: RunOptions): Promise<RunReport> {
  const now = opts.now ?? (() => new Date());
  if (!opts.force && inDiscoveryWindow(now())) {
    throw new GuardHarnessError(
      'Refusing to start inside a discovery window (05:45–07:00, 09:45–11:00, 13:45–15:00 local); pass --force to override',
    );
  }
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new GuardHarnessError(`Concurrency must be 1-${MAX_CONCURRENCY}`);
  }

  dropTornTail(opts.resultsPath);
  const done = new Set(readResults(opts.resultsPath).map((r) => resultKey(r.adapterId, r.itemId)));
  const pending = opts.items.filter((item) => !done.has(resultKey(opts.adapter.id, item.itemId)));
  const selected = opts.limit !== undefined ? pending.slice(0, opts.limit) : pending;

  let evaluated = 0;
  let scoringErrors = 0;
  let consecutiveErrors = 0;
  let aborted = false;
  let totalMs = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!aborted) {
      const item = selected[next++];
      if (!item) return;
      const started = Date.now();
      try {
        const judgement = await opts.adapter.judge(item);
        const durationMs = Date.now() - started;
        const result: HarnessResult = {
          adapterId: opts.adapter.id,
          itemId: item.itemId,
          verdict: judgement.verdict,
          ...(judgement.scores ? { scores: judgement.scores } : {}),
          ...(judgement.probability !== undefined ? { probability: judgement.probability } : {}),
          durationMs,
          evaluatedAt: now().toISOString(),
        };
        appendJsonl(opts.resultsPath, result);
        evaluated += 1;
        totalMs += durationMs;
        consecutiveErrors = 0;
      } catch (err) {
        if (!(err instanceof AdapterScoringError)) throw err;
        scoringErrors += 1;
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) aborted = true;
      }
      opts.onProgress?.(evaluated + scoringErrors, selected.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(selected.length, 1)) }, worker));

  return {
    datasetItems: opts.items.length,
    alreadyEvaluated: opts.items.length - pending.length,
    selected: selected.length,
    evaluated,
    scoringErrors,
    abortedAfterErrors: aborted,
    meanCallMs: evaluated > 0 ? totalMs / evaluated : null,
  };
}
