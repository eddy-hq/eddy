// Guard configurations the harness can replay a dataset through. Each adapter
// judges one item with no side effects; its id keys the result cache, so it
// changes whenever what it measures changes.
//
// The guard is imported lazily: statically it would pull in the shared
// writable DB connection (src/db/client.ts), and snapshot must not open one.
// Only building an adapter (run, report) loads it.
import { config } from '../../config';
import type { CandidatePromptId } from '../guard/index';
import { AdapterScoringError, GuardHarnessError, type HarnessAdapter, type HarnessItem } from './util';

type GuardModule = typeof import('../guard/index');

// The live candidate guard (Gemma) under a given prompt. A v4 id carries the
// rubric version too, so a rubric edit re-evaluates rather than resuming over
// results scored under the old rubric.
function gemmaCandidateAdapter(guard: GuardModule, prompt: CandidatePromptId): HarnessAdapter {
  return {
    id: `gemma:${config.OLLAMA_GUARD_MODEL}:${guard.rerunVersionKey(prompt)}`,
    async judge(item: HarnessItem) {
      const v = await guard.judgeCandidate({
        title: item.title,
        channel: item.channel,
        description: item.description,
        tags: item.tags,
        categoryId: item.categoryId,
        madeForKids: item.madeForKids,
        ageRestricted: item.ageRestricted,
        ageBand: item.ageBand,
        channelHistory: item.channelHistory,
        prompt,
      });
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

// Adapters by CLI name. v3 is the next slice.
const ADAPTERS: Record<string, (guard: GuardModule) => HarnessAdapter> = {
  'gemma-v4': (guard) => gemmaCandidateAdapter(guard, 'v4'),
};

export const DEFAULT_ADAPTER = 'gemma-v4';

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export async function getAdapter(name: string): Promise<HarnessAdapter> {
  const make = ADAPTERS[name];
  if (!make) throw new GuardHarnessError(`Unknown adapter: ${name} (known: ${adapterNames().join(', ')})`);
  return make(await import('../guard/index'));
}
