// Guard configurations the harness can replay a dataset through. Each adapter
// judges one item with no side effects; its id keys the result cache, so it
// changes whenever what it measures changes.
//
// The guard is imported lazily: statically it would pull in the shared
// writable DB connection (src/db/client.ts), and snapshot must not open one.
// Only building an adapter (run, report, calibrate) loads it.
import { config } from '../../config';
import { ollamaGenerateWithLogprobs } from '../../ollama';
import type { CandidatePromptId, RubricDimension, RubricScore } from '../guard/index';
import { scoreDistributions } from './logprob';
import { AdapterScoringError, GuardHarnessError, type HarnessAdapter, type HarnessItem } from './util';

type GuardModule = typeof import('../guard/index');

function judgeInput(item: HarnessItem) {
  return {
    title: item.title,
    channel: item.channel,
    description: item.description,
    tags: item.tags,
    categoryId: item.categoryId,
    madeForKids: item.madeForKids,
    ageRestricted: item.ageRestricted,
    ageBand: item.ageBand,
    channelHistory: item.channelHistory,
  };
}

// The live candidate guard (Gemma) under a given prompt. A v4 id carries the
// rubric version too, so a rubric edit re-evaluates rather than resuming over
// results scored under the old rubric.
function gemmaCandidateAdapter(guard: GuardModule, prompt: CandidatePromptId): HarnessAdapter {
  return {
    id: `gemma:${config.OLLAMA_GUARD_MODEL}:${guard.rerunVersionKey(prompt)}`,
    async judge(item: HarnessItem) {
      const v = await guard.judgeCandidate({ ...judgeInput(item), prompt });
      if (v.reason === guard.GUARD_SCORING_ERROR_REASON) {
        throw new AdapterScoringError('The model never answered');
      }
      return {
        verdict: v.verdict,
        ...(v.rubric ? { scores: { ...v.rubric.scores.dimensions } } : {}),
      };
    },
  };
}

// How the logprob adapter reads the model's token probabilities. Part of its
// id: a change re-evaluates rather than mixing results read two ways.
export const LOGPROB_READ_VERSION = 'logprob-v1';
// Alternatives asked for per token. The four score digits are normally the
// top four at a score position (checked on Ollama 0.34.3).
export const TOP_LOGPROBS = 5;

// What the logprob adapter needs from the guard module. A test passes the
// real rubric pieces without loading the DB.
export type LogprobGuard = Pick<
  GuardModule,
  | 'DIMENSION_OUTPUT_KEYS'
  | 'RUBRIC_CALL_OPTIONS'
  | 'RUBRIC_SCORES_SCHEMA'
  | 'buildRubricPrompt'
  | 'candidateRubricInput'
  | 'parseRubricOutput'
  | 'rerunVersionKey'
  | 'verdictFromScores'
>;

// The incumbent rubric guard (candidate-v4.1) asking Ollama for token
// probabilities too (brief §22 step 2). Same prompt, model, options and
// schema. The verdict is verdictFromScores on the decoded scores, exactly as
// the incumbent decides, so the plain verdict is comparable. Beside it, each
// dimension's distribution over 0–3 (null where its token couldn't be read)
// for the calibration report. Offline only: the live guard is unchanged.
export function gemmaLogprobAdapter(
  guard: LogprobGuard,
  generate: typeof ollamaGenerateWithLogprobs = ollamaGenerateWithLogprobs,
): HarnessAdapter {
  return {
    id: `gemma:${config.OLLAMA_GUARD_MODEL}:${guard.rerunVersionKey('v4')}+${LOGPROB_READ_VERSION}`,
    async judge(item: HarnessItem) {
      // As judgeCandidate: an age-restricted video is clear_no by rule, with
      // no model call.
      if (item.ageRestricted === true) return { verdict: 'clear_no' };
      const prompt = guard.buildRubricPrompt(guard.candidateRubricInput({ ...judgeInput(item), prompt: 'v4' }));
      let result: Awaited<ReturnType<typeof ollamaGenerateWithLogprobs>>;
      try {
        result = await generate(
          prompt, config.OLLAMA_GUARD_MODEL, guard.RUBRIC_CALL_OPTIONS, guard.RUBRIC_SCORES_SCHEMA, TOP_LOGPROBS,
        );
      } catch {
        throw new AdapterScoringError('The model never answered');
      }
      const parsed = guard.parseRubricOutput(result.response);
      if (!parsed) throw new AdapterScoringError('The model never answered with valid scores');
      const decision = guard.verdictFromScores(parsed.scores, item.ageBand, 'discovery');
      return {
        verdict: decision.verdict,
        scores: { ...parsed.scores.dimensions },
        distributions: scoreDistributions(result.response, result.logprobs, guard.DIMENSION_OUTPUT_KEYS),
      };
    },
  };
}

// Adapters by CLI name. v3 is the next slice.
const ADAPTERS: Record<string, (guard: GuardModule) => HarnessAdapter> = {
  'gemma-v4': (guard) => gemmaCandidateAdapter(guard, 'v4'),
  'gemma-v4.1-logprob': (guard) => gemmaLogprobAdapter(guard),
};

export const DEFAULT_ADAPTER = 'gemma-v4';
// calibrate reads this adapter's distributions by default, and sets the
// incumbent's plain verdicts beside it as the baseline.
export const DEFAULT_LOGPROB_ADAPTER = 'gemma-v4.1-logprob';
export const INCUMBENT_ADAPTER = 'gemma-v4';

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export async function getAdapter(name: string): Promise<HarnessAdapter> {
  const make = ADAPTERS[name];
  if (!make) throw new GuardHarnessError(`Unknown adapter: ${name} (known: ${adapterNames().join(', ')})`);
  return make(await import('../guard/index'));
}

export type RubricLimits = Readonly<Record<RubricDimension, RubricScore>>;

// The rubric limits for an age band (limitsBandFor, LIMITS), loaded with the
// guard module as getAdapter loads it.
export async function loadRubricLimits(): Promise<(ageBand: string) => RubricLimits> {
  const guard = await import('../guard/index');
  return (ageBand) => guard.LIMITS[guard.limitsBandFor(ageBand)];
}
