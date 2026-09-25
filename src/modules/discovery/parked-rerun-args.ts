// Argument parsing for `npm run guard:rerun-parked`, kept out of the script so
// the rules (especially the --apply prompt guard) are unit-testable.
import type { CandidatePromptId } from '../guard/index';
import { MAX_RERUN_CONCURRENCY, ParkedRerunError, type RerunPopulation } from './parked-rerun';

export interface RerunArgs {
  apply: boolean;
  forceBackup: boolean;
  // Set only when --prompt was passed; otherwise the live prompt is used.
  prompt?: CandidatePromptId;
  population: RerunPopulation;
  sample?: number;
  seed?: number;
  limit?: number;
  concurrency: number;
}

function positiveInt(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0) {
    throw new ParkedRerunError(`${flag} needs a positive integer`);
  }
  return n;
}

export function parseRerunArgs(argv: readonly string[]): RerunArgs {
  const args: RerunArgs = { apply: false, forceBackup: false, population: 'pending', concurrency: 1 };
  let concurrencyGiven = false;
  let populationGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force-backup') args.forceBackup = true;
    else if (a === '--limit') args.limit = positiveInt('--limit', argv[++i]);
    else if (a === '--sample') args.sample = positiveInt('--sample', argv[++i]);
    else if (a === '--seed') {
      const raw = argv[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 0) throw new ParkedRerunError('--seed needs a non-negative integer');
      args.seed = n;
    } else if (a === '--concurrency') {
      const n = positiveInt('--concurrency', argv[++i]);
      if (n > MAX_RERUN_CONCURRENCY) {
        throw new ParkedRerunError(`--concurrency is capped at ${MAX_RERUN_CONCURRENCY} (Ollama is shared with live traffic)`);
      }
      args.concurrency = n;
      concurrencyGiven = true;
    } else if (a === '--prompt') {
      const v = argv[++i];
      if (v !== 'v3' && v !== 'v4') throw new ParkedRerunError('--prompt must be v3 or v4');
      args.prompt = v;
    } else if (a === '--population') {
      const v = argv[++i];
      if (v !== 'pending' && v !== 'decided') throw new ParkedRerunError('--population must be pending or decided');
      args.population = v;
      populationGiven = true;
    } else {
      throw new ParkedRerunError(`Unknown argument: ${a}`);
    }
  }
  if (args.seed !== undefined && args.sample === undefined) {
    throw new ParkedRerunError('--seed only makes sense with --sample');
  }
  if (args.forceBackup && !args.apply) {
    throw new ParkedRerunError('--force-backup only makes sense with --apply');
  }
  if (args.apply) {
    if (args.limit !== undefined || args.sample !== undefined || concurrencyGiven) {
      throw new ParkedRerunError('--limit, --sample, --seed and --concurrency apply to evaluation only, not --apply');
    }
    // Decided candidates are measurement only: apply moves parked rows alone.
    if (populationGiven && args.population !== 'pending') {
      throw new ParkedRerunError('--apply only applies the parked (pending) population');
    }
  }
  return args;
}

// The prompt a run uses: the explicit --prompt, else the live one. For
// --apply this is the guard against applying v4 verdicts while v3 is live by
// accident — without an explicit --prompt v4 only live-version results apply.
export function resolveRerunPrompt(args: Pick<RerunArgs, 'prompt'>, live: CandidatePromptId): CandidatePromptId {
  return args.prompt ?? live;
}
