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
  guardAdd.mockClear();
  mockRun.mockReset();
  vi.mocked(ollamaGenerate).mockReset();
  vi.mocked(ollamaGenerate).mockResolvedValue('["a","b","c","d"]');
});

describe('processGenerateSearchTerms — kid-interest chain', () => {
  it('enqueues kid-interest-eval after a kid-authored interest', async () => {
    await processGenerateSearchTerms({
      interestId: 'bird_watching', label: 'Bird Watching',
      userId: 'user-kid', isUserAdded: true, isKid: true,
    });

    expect(guardAdd).toHaveBeenCalledTimes(1);
    expect(guardAdd).toHaveBeenCalledWith('kid-interest-eval', {
      userId: 'user-kid',
      interestId: 'bird_watching',
      rawLabel: 'Bird Watching',
    });
  });

  it('does not enqueue when isKid is false', async () => {
    await processGenerateSearchTerms({
      interestId: 'investing', label: 'Investing',
      userId: 'user-parent', isUserAdded: true, isKid: false,
    });

    expect(guardAdd).not.toHaveBeenCalled();
  });

  it('does not enqueue when isUserAdded is false', async () => {
    await processGenerateSearchTerms({
      interestId: 'seeded', label: 'Seeded Interest',
      userId: 'user-kid', isUserAdded: false, isKid: true,
    });

    expect(guardAdd).not.toHaveBeenCalled();
  });

  it('persists search terms to interests.search_terms', async () => {
    await processGenerateSearchTerms({
      interestId: 'x', label: 'X',
      userId: 'user-kid', isUserAdded: true, isKid: true,
    });

    const updateCall = mockRun.mock.calls.find((c) => c[0] === JSON.stringify(['a', 'b', 'c', 'd']));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toBe('x');
  });

  it('throws on unparseable Gemma response so BullMQ retries', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('not json');
    await expect(processGenerateSearchTerms({
      interestId: 'x', label: 'X',
      userId: 'user-kid', isUserAdded: true, isKid: true,
    })).rejects.toThrow(/parse failed/i);

    // No update, no chain enqueue
    expect(mockRun).not.toHaveBeenCalled();
    expect(guardAdd).not.toHaveBeenCalled();
  });
});

describe('processGenerateSearchTerms — specificity (ADR-0008)', () => {
  it('persists [] for a too-broad label and does not throw', async () => {
    // Gemma judges "AI" too broad and returns an empty array.
    vi.mocked(ollamaGenerate).mockResolvedValue('[]');
    await processGenerateSearchTerms({
      interestId: 'ai', label: 'AI',
      userId: 'user-parent', isUserAdded: true, isKid: false,
    });

    const updateCall = mockRun.mock.calls.find((c) => c[1] === 'ai');
    expect(updateCall).toBeDefined();
    expect(updateCall?.[0]).toBe('[]');
  });

  it('persists generated terms for a specific label', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(
      '["trail running shoe reviews","ultramarathon training plan","running cadence drills","zone 2 running"]'
    );
    await processGenerateSearchTerms({
      interestId: 'trail_running', label: 'Trail running shoe reviews',
      userId: 'user-parent', isUserAdded: true, isKid: false,
    });

    const updateCall = mockRun.mock.calls.find((c) => c[1] === 'trail_running');
    expect(updateCall).toBeDefined();
    expect(JSON.parse(updateCall?.[0] as string)).toEqual([
      'trail running shoe reviews',
      'ultramarathon training plan',
      'running cadence drills',
      'zone 2 running',
    ]);
  });

  it('still runs the kid-interest guard chain for a broad kid-authored interest', async () => {
    // A broad label gets empty search terms but the kid guard eval must still
    // fire against the raw label — the guard judges the interest, not its
    // searchability.
    vi.mocked(ollamaGenerate).mockResolvedValue('[]');
    await processGenerateSearchTerms({
      interestId: 'ai', label: 'AI',
      userId: 'user-kid', isUserAdded: true, isKid: true,
    });

    expect(guardAdd).toHaveBeenCalledTimes(1);
    expect(guardAdd).toHaveBeenCalledWith('kid-interest-eval', {
      userId: 'user-kid',
      interestId: 'ai',
      rawLabel: 'AI',
    });
  });
});
