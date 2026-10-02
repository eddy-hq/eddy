// Guard configurations the harness can replay a dataset through. Each adapter
// judges one item with no side effects; its id keys the result cache, so it
// changes whenever what it measures changes.
import { config } from '../../config';
import {
  GUARD_SCORING_ERROR_REASON,
  judgeCandidate,
  rerunVersionKey,
  type CandidatePromptId,
} from '../guard/index';
import { AdapterScoringError, GuardHarnessError, type HarnessAdapter, type HarnessItem } from './util';

// The live candidate guard (Gemma) under a given prompt. A v4 id carries the
// rubric version too, so a rubric edit re-evaluates rather than resuming over
// results scored under the old rubric.
function gemmaCandidateAdapter(prompt: CandidatePromptId): HarnessAdapter {
  return {
    id: `gemma:${config.OLLAMA_GUARD_MODEL}:${rerunVersionKey(prompt)}`,
    async judge(item: HarnessItem) {
      const v = await judgeCandidate({
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
      if (v.reason === GUARD_SCORING_ERROR_REASON) {
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
const ADAPTERS: Record<string, () => HarnessAdapter> = {
  'gemma-v4': () => gemmaCandidateAdapter('v4'),
};

export const DEFAULT_ADAPTER = 'gemma-v4';

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export function getAdapter(name: string): HarnessAdapter {
  const make = ADAPTERS[name];
  if (!make) throw new GuardHarnessError(`Unknown adapter: ${name} (known: ${adapterNames().join(', ')})`);
  return make();
}
