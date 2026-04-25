import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inferChannelInterests } from './index';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' },
}));

const { mockedWarn } = vi.hoisted(() => ({ mockedWarn: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: mockedWarn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', () => ({
  ollamaGenerate: vi.fn(),
}));

const validInterests = [
  { id: 'minecraft', label: 'Minecraft', category: 'gaming' },
  { id: 'programming', label: 'Programming', category: 'tech' },
];

let existingLink: { 1: number } | undefined;
const mockRun = vi.fn();
const insertSqls: string[] = [];

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM channel_interest_links')) return existingLink;
        return undefined;
      }),
      all: vi.fn(() => {
        if (sql.includes('FROM interests ORDER BY')) return validInterests;
        return [];
      }),
      run: vi.fn((...args: unknown[]) => {
        if (sql.includes('INTO channel_interest_links')) insertSqls.push(sql);
        return mockRun(...args);
      }),
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';

beforeEach(() => {
  existingLink = undefined;
  mockRun.mockReset();
  insertSqls.length = 0;
  mockedWarn.mockReset();
  vi.mocked(ollamaGenerate).mockReset();
  // Default fetch: return an empty RSS body so the prompt is built without titles.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    text: async () => '<feed></feed>',
  })));
});

describe('inferChannelInterests', () => {
  it('exits early when the channel already has a link, without calling Ollama', async () => {
    existingLink = { 1: 1 };
    await inferChannelInterests('UC123', 'Some Channel');
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
    expect(insertSqls).toHaveLength(0);
  });

  it('filters Gemma-returned ids against the valid set and inserts with confidence 1.0', async () => {
    // Function caps Gemma's list at 2 ids, so the invalid one must sit in the
    // first two slots to actually exercise the validity filter.
    vi.mocked(ollamaGenerate).mockResolvedValue('["minecraft","not_a_real_id"]');
    await inferChannelInterests('UC123', 'Coder Plays Minecraft');

    const insertedInterestIds = mockRun.mock.calls
      .filter((c) => c[0] === 'UC123')
      .map((c) => c[1]);
    expect(insertedInterestIds).toEqual(['minecraft']);

    // Each insert SQL had `confidence, inferred_at) VALUES (?, ?, 1.0, ?)`
    for (const sql of insertSqls) {
      expect(sql).toContain('1.0');
    }
  });

  it('logs a warning and inserts nothing when the Gemma response is malformed', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('here is the answer: [bad json] thanks');
    await expect(inferChannelInterests('UC456', 'Other Channel')).resolves.toBeUndefined();

    expect(insertSqls).toHaveLength(0);
    expect(mockedWarn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'UC456' }),
      'Channel interest inference: could not parse response',
    );
  });
});
