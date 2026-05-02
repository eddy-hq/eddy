import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

const { guardAdd } = vi.hoisted(() => ({ guardAdd: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../queue', () => ({
  redis: {},
  guardQueue: { add: guardAdd },
  interestsQueue: { add: vi.fn() },
}));

let userRole: 'kid' | 'parent' | undefined = 'kid';
const mockRun = vi.fn();

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM users')) return userRole ? { role: userRole } : undefined;
        return undefined;
      }),
      run: mockRun,
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';
import { processGenerateSearchTerms } from './searchTermsWorker';

beforeEach(() => {
  guardAdd.mockClear();
  mockRun.mockReset();
  vi.mocked(ollamaGenerate).mockReset();
  vi.mocked(ollamaGenerate).mockResolvedValue('["a","b","c","d"]');
  userRole = 'kid';
});

describe('processGenerateSearchTerms — kid-interest chain', () => {
  it('enqueues kid-interest-eval after a kid-authored interest', async () => {
    userRole = 'kid';
    await processGenerateSearchTerms({
      interestId: 'bird_watching', label: 'Bird Watching',
      userId: 'user-kid', isUserAdded: true,
    });

    expect(guardAdd).toHaveBeenCalledTimes(1);
    expect(guardAdd).toHaveBeenCalledWith('kid-interest-eval', {
      userId: 'user-kid',
      interestId: 'bird_watching',
      rawLabel: 'Bird Watching',
    });
  });

  it('does not enqueue when the author is a parent', async () => {
    userRole = 'parent';
    await processGenerateSearchTerms({
      interestId: 'investing', label: 'Investing',
      userId: 'user-parent', isUserAdded: true,
    });

    expect(guardAdd).not.toHaveBeenCalled();
  });

  it('does not enqueue when isUserAdded is false', async () => {
    userRole = 'kid';
    await processGenerateSearchTerms({
      interestId: 'seeded', label: 'Seeded Interest',
      userId: 'user-kid', isUserAdded: false,
    });

    expect(guardAdd).not.toHaveBeenCalled();
  });

  it('persists search terms to interests.search_terms', async () => {
    await processGenerateSearchTerms({
      interestId: 'x', label: 'X', userId: 'user-kid', isUserAdded: true,
    });

    const updateCall = mockRun.mock.calls.find((c) => c[0] === JSON.stringify(['a', 'b', 'c', 'd']));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toBe('x');
  });
});
