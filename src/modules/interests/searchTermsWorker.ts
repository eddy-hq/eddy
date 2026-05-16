import { Worker } from 'bullmq';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { redis } from '../../queue';

// Generate 4 YouTube search queries for a freeform interest label and persist
// them on the row so discovery can use them on the next pass. The kid-interest
// guard eval (#110) runs in-band from the interests router on add; it is no
// longer chained from this worker.
export const GENERATE_SEARCH_TERMS_JOB = 'generate-search-terms';

export interface GenerateSearchTermsJob {
  interestId: string;
  label: string;
  userId: string;
  isUserAdded: boolean;
}

export async function processGenerateSearchTerms(job: GenerateSearchTermsJob): Promise<void> {
  const { interestId, label } = job;
  const prompt = `Generate 4 YouTube search queries that would find good videos about "${label}". Return a JSON array of strings only, for example ["query one","query two","query three","query four"]. No explanation.`;

  const raw = await ollamaGenerate(prompt);
  const terms = parseOllamaJson<string[]>(raw, 'array', (parsed) => {
    if (!Array.isArray(parsed)) return null;
    return (parsed as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 4);
  });
  // Throw on parse failure so BullMQ retries per the queue's backoff policy
  // — a successful no-op would leave search_terms='[]' permanently and the
  // interest would never surface candidates.
  if (!terms) {
    logger.warn({ interestId, raw }, 'Search-terms job: could not parse Gemma response — failing for retry');
    throw new Error('Search-terms parse failed');
  }

  db.prepare('UPDATE interests SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(terms), interestId);

  logger.info({ interestId, terms }, 'Search-terms job: interest search terms generated');
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
