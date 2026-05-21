import { db } from '../../db/client';
import { logger } from '../../logger';
import { interestsQueue } from '../../queue';
import { GENERATE_SEARCH_TERMS_JOB, type GenerateSearchTermsJob } from './searchTermsWorker';

// Sentinel written by migration 033 to mark an interest whose search_terms must
// be regenerated under the specificity-aware prompt (ADR-0008). It is
// deliberately not a JSON array, so every reader (intake gap-filler, scoring,
// guard) that JSON.parses search_terms falls back to "no terms" — a pending
// interest behaves as broad/unsearchable until the worker reconciles it,
// without leaking a malformed query.
export const SEARCH_TERMS_PENDING = '__pending_specificity__';

// A .sql migration cannot call Gemma, so migration 033 resets every existing
// interest's search_terms to the pending sentinel and this startup reconcile
// re-enqueues generation. Each job runs the new specificity-aware prompt, so
// broad interests ("AI", "Running") land on '[]' and specific ones get fresh
// terms — genuinely re-running the LLM specificity judgement over the existing
// set rather than faking a verdict in static SQL. Enqueued as a system act
// (isUserAdded: false) so it never triggers the kid-interest guard chain.
export function reconcilePendingSearchTerms(): void {
  const pending = db.prepare(
    'SELECT id, label FROM interests WHERE search_terms = ?'
  ).all(SEARCH_TERMS_PENDING) as Array<{ id: string; label: string }>;

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, 'Search-terms reconcile: re-enqueuing specificity check for pending interests');

  for (const interest of pending) {
    const payload: GenerateSearchTermsJob = {
      interestId: interest.id,
      label: interest.label,
      userId: 'system-reconcile',
      isUserAdded: false,
      isKid: false,
    };
    void interestsQueue.add(GENERATE_SEARCH_TERMS_JOB, payload).catch((err: unknown) => {
      logger.warn({ err, interestId: interest.id }, 'Search-terms reconcile: failed to enqueue regeneration');
    });
  }
}
