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

vi.mock('../../queue', () => ({
  redis: {},
  interestsQueue: { add: vi.fn() },
}));

const mockRun = vi.fn();

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      run: mockRun,
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';
import { processGenerateSearchTerms } from './searchTermsWorker';

beforeEach(() => {
  mockRun.mockReset();
  vi.mocked(ollamaGenerate).mockReset();
  vi.mocked(ollamaGenerate).mockResolvedValue('["a","b","c","d"]');
});

describe('processGenerateSearchTerms', () => {
  it('persists search terms to interests.search_terms', async () => {
    await processGenerateSearchTerms({
      interestId: 'x', label: 'X',
      userId: 'user-kid', isUserAdded: true,
    });

    const updateCall = mockRun.mock.calls.find((c) => c[0] === JSON.stringify(['a', 'b', 'c', 'd']));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toBe('x');
  });

  it('throws on unparseable Gemma response so BullMQ retries', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('not json');
    await expect(processGenerateSearchTerms({
      interestId: 'x', label: 'X',
      userId: 'user-kid', isUserAdded: true,
    })).rejects.toThrow(/parse failed/i);

    // No DB update on parse failure
    expect(mockRun).not.toHaveBeenCalled();
  });
});
