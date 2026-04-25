import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeUserAddedInterest } from './normalize';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', () => ({
  ollamaGenerate: vi.fn(),
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

import { ollamaGenerate } from '../../ollama';

beforeEach(() => {
  nextRank = 1;
  existingMatch = undefined;
  mockRun.mockReset();
  prepareCalls.length = 0;
  vi.mocked(ollamaGenerate).mockReset();
  vi.mocked(ollamaGenerate).mockResolvedValue('["a","b","c","d"]');
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('normalizeUserAddedInterest', () => {
  it('derives a slug, inserts into interests + user_interests at next rank', async () => {
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

    // No INSERT into interests should have happened — find any prepare whose SQL
    // is the interests INSERT and confirm its run() was never called with cycling args
    const sawInterestsInsert = prepareCalls.some((sql) =>
      sql.includes('INSERT OR IGNORE INTO interests'),
    );
    // The prepare itself may have been compiled, but with existingMatch set
    // the code path skips it entirely.
    expect(sawInterestsInsert).toBe(false);

    // user_interests insert still happens, against the existing id
    const userInterestsInsert = mockRun.mock.calls.find(
      (c) => c[0] === 'user-1' && c[1] === 'cycling',
    );
    expect(userInterestsInsert).toBeDefined();
  });

  it('falls back to a UUID when the label has no alphanumerics', () => {
    const result = normalizeUserAddedInterest('user-1', '!!!');
    // UUIDs contain hyphens; the slug-only path would produce an empty string.
    expect(result.interestId).toMatch(/[0-9a-f-]{20,}/);
    expect(result.isNew).toBe(true);
  });

  it('fires generateSearchTermsAsync for new interests only', async () => {
    normalizeUserAddedInterest('user-1', 'Bird Watching');
    await flushMicrotasks();
    expect(vi.mocked(ollamaGenerate)).toHaveBeenCalledTimes(1);

    vi.mocked(ollamaGenerate).mockClear();
    existingMatch = { id: 'cycling' };
    normalizeUserAddedInterest('user-1', 'Cycling');
    await flushMicrotasks();
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });
});
