import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeUserAddedInterest } from './normalize';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { interestsAdd } = vi.hoisted(() => ({
  interestsAdd: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../queue', () => ({
  interestsQueue: { add: interestsAdd },
}));

let nextRank = 1;
let existingMatch: { id: string } | undefined;
const mockRun = vi.fn();
const prepareCalls: string[] = [];

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn((sql: string) => {
      prepareCalls.push(sql);
      return {
        get: vi.fn(() => {
          if (sql.includes('MAX(rank)')) return { r: nextRank };
          if (sql.includes('FROM interests WHERE id')) return existingMatch;
          return undefined;
        }),
        run: mockRun,
        all: vi.fn(() => []),
      };
    }),
  },
}));

beforeEach(() => {
  nextRank = 1;
  existingMatch = undefined;
  mockRun.mockReset();
  prepareCalls.length = 0;
  interestsAdd.mockClear();
});

describe('normalizeUserAddedInterest', () => {
  it('derives a slug, inserts into interests + user_interests at next rank', () => {
    nextRank = 4;
    const result = normalizeUserAddedInterest('user-1', 'Bird Watching');

    expect(result).toEqual({ interestId: 'bird_watching', label: 'Bird Watching', isNew: true });

    const interestsInsert = mockRun.mock.calls.find(
      (c) => c[0] === 'bird_watching' && c[1] === 'Bird Watching',
    );
    expect(interestsInsert).toBeDefined();

    const userInterestsInsert = mockRun.mock.calls.find(
      (c) => c[0] === 'user-1' && c[1] === 'bird_watching' && c[2] === 4,
    );
    expect(userInterestsInsert).toBeDefined();
  });

  it('links to existing interest by label match without re-inserting into interests', () => {
    existingMatch = { id: 'cycling' };
    const result = normalizeUserAddedInterest('user-1', 'Cycling');

    expect(result).toEqual({ interestId: 'cycling', label: 'Cycling', isNew: false });

    const sawInterestsInsert = prepareCalls.some((sql) =>
      sql.includes('INSERT OR IGNORE INTO interests'),
    );
    expect(sawInterestsInsert).toBe(false);

    const userInterestsInsert = mockRun.mock.calls.find(
      (c) => c[0] === 'user-1' && c[1] === 'cycling',
    );
    expect(userInterestsInsert).toBeDefined();
  });

  it('falls back to a UUID when the label has no alphanumerics', () => {
    const result = normalizeUserAddedInterest('user-1', '!!!');
    expect(result.interestId).toMatch(/[0-9a-f-]{20,}/);
    expect(result.isNew).toBe(true);
  });

  it('enqueues generate-search-terms for a new interest', () => {
    normalizeUserAddedInterest('user-1', 'Bird Watching');

    expect(interestsAdd).toHaveBeenCalledTimes(1);
    expect(interestsAdd).toHaveBeenCalledWith('generate-search-terms', {
      interestId: 'bird_watching',
      label: 'Bird Watching',
      userId: 'user-1',
      isUserAdded: true,
    });
  });

  it('does not enqueue search-terms when linking to an existing interest', () => {
    existingMatch = { id: 'cycling' };
    normalizeUserAddedInterest('user-1', 'Cycling');

    expect(interestsAdd).not.toHaveBeenCalled();
  });
});
