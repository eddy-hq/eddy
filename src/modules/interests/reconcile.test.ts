import { describe, it, expect, vi, beforeEach } from 'vitest';

// reconcile.ts imports searchTermsWorker for the job name + payload type, which
// transitively imports ollama → config. Stub config so importing the module
// under test doesn't trip the zod env validation (which calls process.exit).
vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { interestsAdd } = vi.hoisted(() => ({
  interestsAdd: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../queue', () => ({
  redis: {},
  interestsQueue: { add: interestsAdd },
  guardQueue: { add: vi.fn() },
}));

const mockAll = vi.fn();
vi.mock('../../db/client', () => ({
  db: { prepare: vi.fn(() => ({ all: mockAll })) },
}));

import { reconcilePendingSearchTerms, SEARCH_TERMS_PENDING } from './reconcile';
import { GENERATE_SEARCH_TERMS_JOB } from './searchTermsWorker';

beforeEach(() => {
  interestsAdd.mockClear();
  mockAll.mockReset();
});

describe('reconcilePendingSearchTerms', () => {
  it('re-enqueues generation for each pending interest as a system act', () => {
    mockAll.mockReturnValue([
      { id: 'ai', label: 'AI' },
      { id: 'trail_running', label: 'Trail running shoe reviews' },
    ]);

    reconcilePendingSearchTerms();

    expect(interestsAdd).toHaveBeenCalledTimes(2);
    expect(interestsAdd).toHaveBeenCalledWith(GENERATE_SEARCH_TERMS_JOB, {
      interestId: 'ai',
      label: 'AI',
      userId: 'system-reconcile',
      isUserAdded: false,
      isKid: false,
    });
    // isUserAdded:false guarantees the kid-interest guard chain never fires
    // for a system reconcile.
    for (const call of interestsAdd.mock.calls) {
      expect(call[1].isUserAdded).toBe(false);
      expect(call[1].isKid).toBe(false);
    }
  });

  it('does nothing when no interests carry the sentinel', () => {
    mockAll.mockReturnValue([]);

    reconcilePendingSearchTerms();

    expect(interestsAdd).not.toHaveBeenCalled();
  });

  it('uses a sentinel that is not a valid JSON array', () => {
    // Readers JSON.parse search_terms and fall back to no-terms on failure;
    // the sentinel must therefore never parse to an array.
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(SEARCH_TERMS_PENDING); }).toThrow();
    expect(Array.isArray(parsed)).toBe(false);
  });
});
