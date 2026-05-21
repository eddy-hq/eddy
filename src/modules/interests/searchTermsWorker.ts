import { Worker } from 'bullmq';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { redis, guardQueue } from '../../queue';
import { KID_INTEREST_EVAL_JOB } from '../guard/index';

// Generate 4 YouTube search queries for a freeform interest label and persist
// them on the row. Used by the kid-interest guard chain (#52) as the point at
// which `search_terms` is populated before the guard eval reads it.
export const GENERATE_SEARCH_TERMS_JOB = 'generate-search-terms';

export interface GenerateSearchTermsJob {
  interestId: string;
  label: string;
  userId: string;
  isUserAdded: boolean;
  // Resolved at enqueue time and passed through so the chain decision uses the
  // role at submission, and the worker doesn't have to round-trip to users.
  isKid: boolean;
}

export async function processGenerateSearchTerms(job: GenerateSearchTermsJob): Promise<void> {
  const { interestId, label, userId, isUserAdded, isKid } = job;
  // Specificity-aware generation (ADR-0008): an interest plays two decoupled
  // roles. Scoring vocabulary uses every interest regardless of search terms;
  // the search seed (gap-filler ytsearch queries) should only fire for labels
  // specific enough to yield good results. A broad label like "AI" or
  // "Running" must return [] so it stays as vocabulary but never generates a
  // query. We ask Gemma to judge specificity in the same call, returning an
  // empty array for too-broad labels — distinct from a parse failure.
  const prompt = `You generate YouTube search queries for a content recommendation system.

Interest label: "${label}"

First decide whether this label is specific enough to yield good YouTube search results. Broad, catch-all topics (e.g. "AI", "Running", "Music", "Science") match far too many unrelated videos to search well — these are too broad. A label that names a concrete activity, niche, technique, or subject (e.g. "trail running shoe reviews", "fine-tuning language models", "fingerstyle guitar") is specific enough.

If the label is too broad to search well, return an empty JSON array: []
Otherwise return a JSON array of exactly 4 specific search query strings, for example ["query one","query two","query three","query four"].

Return the JSON array only. No explanation.`;

  const raw = await ollamaGenerate(prompt);
  // Distinguish three outcomes: an explicit [] (too broad — keep as
  // vocabulary, no search seed), a populated array (specific — searchable),
  // and a parse failure (Gemma misbehaved — retry). `parseOllamaJson` returns
  // null only when no JSON array block is present or it doesn't parse, so a
  // valid [] flows through as an empty array, not null.
  const terms = parseOllamaJson<string[]>(raw, 'array', (parsed) => {
    if (!Array.isArray(parsed)) return null;
    return (parsed as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 4);
  });
  // Throw on parse failure so BullMQ retries per the queue's backoff policy.
  // A genuine [] (too-broad verdict) is a successful outcome and is persisted;
  // only a null (unparseable) response fails for retry.
  if (!terms) {
    logger.warn({ interestId, raw }, 'Search-terms job: could not parse Gemma response — failing for retry');
    throw new Error('Search-terms parse failed');
  }

  db.prepare('UPDATE interests SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(terms), interestId);

  if (terms.length === 0) {
    logger.info({ interestId, label }, 'Search-terms job: interest judged too broad to search — kept as scoring vocabulary only');
  } else {
    logger.info({ interestId, terms }, 'Search-terms job: interest search terms generated');
  }

  // Chain: only kid-authored freeform interests get a guard eval. Adult-typed
  // interests are trusted, and the curated /select flow doesn't enqueue at all.
  if (isUserAdded && isKid) {
    await guardQueue.add(KID_INTEREST_EVAL_JOB, { userId, interestId, rawLabel: label });
  }
}

let worker: Worker | null = null;

export function startInterestsWorker(): void {
  worker = new Worker<GenerateSearchTermsJob>('interests', async (job) => {
    if (job.name === GENERATE_SEARCH_TERMS_JOB) {
      await processGenerateSearchTerms(job.data);
      return;
    }
    throw new Error(`Interests worker: unknown job name '${job.name}'`);
  }, { connection: redis, concurrency: 1 });

  worker.on('failed', (job, err) => {
    logger.warn({ err, jobId: job?.id, interestId: job?.data?.interestId }, 'Interests worker: job failed');
  });

  logger.info('Interests worker started');
}

export async function stopInterestsWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
