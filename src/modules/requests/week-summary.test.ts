import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
    OLLAMA_SUMMARY_MODEL: undefined,
  },
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

// DB mock routed by SQL substring. `displayNames` drives the household name
// lookup used by the PII guard; `cacheRows` backs readWeekSummaryCache; every
// .run() is captured on `mockRun` so upsert args can be inspected.
let displayNames: Array<{ display_name: string | null }> = [];
let cacheRows: Array<{ week_start: string; item_count: number; summary: string | null }> = [];
let feedRows: Array<{
  title: string | null; channel: string | null; source: string;
  requested_at: string; added_at: string | null;
}> = [];
const mockRun = vi.fn();

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => undefined),
      all: vi.fn(() => {
        if (sql.includes('FROM users')) return displayNames;
        if (sql.includes('FROM tier4_week_summaries')) return cacheRows;
        if (sql.includes('FROM requests')) return feedRows;
        return [];
      }),
      run: mockRun,
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';
import {
  buildWeekSummaryPrompt,
  guardSummary,
  redactNames,
  generateWeekSummary,
  cachedSummaryForWeek,
  computeStaleWeeks,
  groupTier4Weeks,
  applyCachedSummaries,
  readWeekSummaryCache,
  writeWeekSummary,
  regenerateStaleWeekSummaries,
  WEEK_SUMMARY_PROMPT_VERSION,
  type WeekSummaryItem,
  type StaleWeek,
} from './week-summary';
import type { Tier4Week, TierInputRow } from './feed-tiers';

beforeEach(() => {
  displayNames = [];
  cacheRows = [];
  feedRows = [];
  mockRun.mockReset();
  vi.mocked(ollamaGenerate).mockReset();
});

const sampleItems: WeekSummaryItem[] = [
  { title: 'Minecraft survival ep 1', channel: 'BlockCraft', kind: 'req' },
  { title: 'How magnets work', channel: 'Steve Mould', kind: 'pick' },
];

describe('buildWeekSummaryPrompt', () => {
  it('embeds the count, the shape spec, the titles and channels — but never a user id', () => {
    const prompt = buildWeekSummaryPrompt(38, sampleItems);
    expect(prompt).toContain('38 items');
    expect(prompt).toContain('38 items · {your prose}');
    expect(prompt).toContain('Minecraft survival ep 1');
    expect(prompt).toContain('BlockCraft');
    expect(prompt).toContain('Steve Mould');
    expect(prompt).toContain('UK English');
  });

  it('caps how many items it lists in the prompt', () => {
    const many: WeekSummaryItem[] = Array.from({ length: 100 }, (_, i) => ({
      title: `Video ${i}`, channel: 'Ch', kind: 'pick' as const,
    }));
    const prompt = buildWeekSummaryPrompt(100, many);
    expect(prompt).toContain('Video 0');
    expect(prompt).toContain('Video 39');
    // 41st item (index 40) and beyond are dropped from the prompt body.
    expect(prompt).not.toContain('Video 40.');
    expect(prompt).not.toContain('41. "Video 40"');
  });

  it('redacts household real names from titles and channels before they reach Gemma', () => {
    const items: WeekSummaryItem[] = [
      { title: 'A day out with Alice', channel: 'Bob and friends', kind: 'pick' },
    ];
    const prompt = buildWeekSummaryPrompt(1, items, ['alice', 'bob']);
    expect(prompt).not.toContain('Alice');
    expect(prompt).not.toContain('Bob');
    expect(prompt).toContain('[name]');
  });
});

describe('redactNames', () => {
  it('replaces a household name on a word boundary, case-insensitively', () => {
    expect(redactNames('A vlog by Alice', ['alice'])).toBe('A vlog by [name]');
    expect(redactNames('ALICE builds a den', ['alice'])).toBe('[name] builds a den');
  });

  it('leaves substrings of other words untouched', () => {
    expect(redactNames('all about robotics', ['rob'])).toBe('all about robotics');
  });

  it('is a no-op with no names', () => {
    expect(redactNames('Minecraft survival', [])).toBe('Minecraft survival');
  });
});

describe('guardSummary', () => {
  it('accepts a well-formed line and strips a trailing full stop', () => {
    const out = guardSummary('38 items · mostly Minecraft, a run of Steve Mould.', 38, []);
    expect(out).toBe('38 items · mostly Minecraft, a run of Steve Mould');
  });

  it('strips surrounding quotes the model sometimes adds', () => {
    const out = guardSummary('"12 items · a quiet week of science"', 12, []);
    expect(out).toBe('12 items · a quiet week of science');
  });

  it('rejects output over 80 chars (fallback null)', () => {
    const longProse = 'x'.repeat(90);
    const out = guardSummary(`5 items · ${longProse}`, 5, []);
    expect(out).toBeNull();
  });

  it('rejects output that does not start with the "{count} items · " shape', () => {
    expect(guardSummary('a lovely week of Minecraft', 38, [])).toBeNull();
    // Wrong count in the prefix is also a shape failure.
    expect(guardSummary('12 items · mostly Minecraft', 38, [])).toBeNull();
    // Prefix present but no prose.
    expect(guardSummary('38 items · ', 38, [])).toBeNull();
  });

  it('rejects output containing a household real name (case-insensitive, word boundary)', () => {
    const names = ['alice', 'bob'];
    expect(guardSummary('7 items · a busy week for Alice', 7, names)).toBeNull();
    expect(guardSummary('7 items · BOB watched a lot', 7, names)).toBeNull();
    // A name that only appears as a substring of another word does not trip it.
    expect(guardSummary('7 items · all about robotics', 7, ['rob'])).toBe('7 items · all about robotics');
  });

  it('returns null for empty input', () => {
    expect(guardSummary('', 3, [])).toBeNull();
    expect(guardSummary('   ', 3, [])).toBeNull();
  });
});

describe('generateWeekSummary', () => {
  const week: StaleWeek = { weekStart: '2026-01-05', count: 38, items: sampleItems };

  it('happy path: returns the guarded line', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('38 items · mostly Minecraft, a run of Steve Mould');
    const out = await generateWeekSummary(week);
    expect(out).toBe('38 items · mostly Minecraft, a run of Steve Mould');
  });

  it('output too long → fallback null', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue(`38 items · ${'y'.repeat(100)}`);
    const out = await generateWeekSummary(week);
    expect(out).toBeNull();
  });

  it('output contains a kid real name → fallback null', async () => {
    displayNames = [{ display_name: 'Charlie' }, { display_name: 'Dana' }];
    vi.mocked(ollamaGenerate).mockResolvedValue('38 items · a strong week for Charlie');
    const out = await generateWeekSummary(week);
    expect(out).toBeNull();
  });

  it('Gemma unreachable → null', async () => {
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));
    const out = await generateWeekSummary(week);
    expect(out).toBeNull();
  });

  it('passes the configured summary model (undefined → guard-model default) to ollamaGenerate', async () => {
    vi.mocked(ollamaGenerate).mockResolvedValue('38 items · plenty of science');
    await generateWeekSummary(week);
    const modelArg = vi.mocked(ollamaGenerate).mock.calls[0]?.[1];
    expect(modelArg).toBeUndefined();
  });
});

describe('cachedSummaryForWeek (cache hit / stale logic)', () => {
  it('returns the stored summary when the cached count matches (hit)', () => {
    const cache = new Map([
      ['2026-01-05', { week_start: '2026-01-05', item_count: 38, summary: '38 items · a good week' }],
    ]);
    expect(cachedSummaryForWeek(cache, '2026-01-05', 38)).toBe('38 items · a good week');
  });

  it('returns null when the count changed (stale)', () => {
    const cache = new Map([
      ['2026-01-05', { week_start: '2026-01-05', item_count: 38, summary: '38 items · a good week' }],
    ]);
    expect(cachedSummaryForWeek(cache, '2026-01-05', 40)).toBeNull();
  });

  it('returns null when there is no cached row', () => {
    expect(cachedSummaryForWeek(new Map(), '2026-01-05', 10)).toBeNull();
  });

  it('returns the stored null when a prior generation was guarded to null but count still matches', () => {
    const cache = new Map([
      ['2026-01-05', { week_start: '2026-01-05', item_count: 5, summary: null }],
    ]);
    expect(cachedSummaryForWeek(cache, '2026-01-05', 5)).toBeNull();
  });
});

describe('applyCachedSummaries', () => {
  it('fills summary from a matching cache row and leaves stale weeks null', () => {
    const weeks: Tier4Week[] = [
      { rangeStart: '2026-01-05', rangeEnd: '2026-01-11', count: 38, topChannels: [], summary: null },
      { rangeStart: '2025-12-29', rangeEnd: '2026-01-04', count: 10, topChannels: [], summary: null },
    ];
    const cache = new Map([
      ['2026-01-05', { week_start: '2026-01-05', item_count: 38, summary: '38 items · a good week' }],
      ['2025-12-29', { week_start: '2025-12-29', item_count: 9, summary: '9 items · stale, count moved on' }],
    ]);
    const out = applyCachedSummaries(weeks, cache);
    expect(out[0]?.summary).toBe('38 items · a good week');
    expect(out[1]?.summary).toBeNull();
  });
});

describe('computeStaleWeeks', () => {
  // todayStr chosen so the rows below are all ≥30 days old (Tier 4).
  const today = '2026-03-01';
  const rows: TierInputRow[] = [
    { day: '2026-01-05', title: 'A', channel: 'C1', source: 'share_sheet' },
    { day: '2026-01-06', title: 'B', channel: 'C2', source: 'recommended' },
    { day: '2026-01-07', title: null, channel: null, source: 'recommended' },
  ];

  it('flags a week with no cached row as stale, counting every row (incl. title-less)', () => {
    const stale = computeStaleWeeks(rows, today, new Map());
    expect(stale).toHaveLength(1);
    expect(stale[0]?.weekStart).toBe('2026-01-05');
    expect(stale[0]?.count).toBe(3); // all three rows count
    expect(stale[0]?.items).toHaveLength(2); // only titled rows reach the prompt
  });

  it('treats a week whose count changed as stale', () => {
    const cache = new Map([
      ['2026-01-05', { week_start: '2026-01-05', item_count: 2, summary: 'x' }],
    ]);
    const stale = computeStaleWeeks(rows, today, cache);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.count).toBe(3);
  });

  it('skips a week whose cached count is unchanged (reuse, not stale)', () => {
    const cache = new Map([
      ['2026-01-05', { week_start: '2026-01-05', item_count: 3, summary: 'x' }],
    ]);
    const stale = computeStaleWeeks(rows, today, cache);
    expect(stale).toHaveLength(0);
  });

  it('ignores rows newer than 30 days (not Tier 4)', () => {
    const recent: TierInputRow[] = [
      { day: '2026-02-25', title: 'recent', channel: 'C', source: 'recommended' },
    ];
    const stale = computeStaleWeeks(recent, today, new Map());
    expect(stale).toHaveLength(0);
  });
});

describe('groupTier4Weeks', () => {
  const today = '2026-03-01';
  const rows: TierInputRow[] = [
    { day: '2026-01-05', title: 'A', channel: 'C1', source: 'share_sheet' },
    { day: '2026-01-06', title: null, channel: null, source: 'recommended' },
  ];

  it('returns every Tier 4 week with count over all rows but items over titled rows only', () => {
    const weeks = groupTier4Weeks(rows, today);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.count).toBe(2);
    expect(weeks[0]?.items).toHaveLength(1);
  });

  it('excludes rows newer than 30 days', () => {
    const recent: TierInputRow[] = [
      { day: '2026-02-25', title: 'recent', channel: 'C', source: 'recommended' },
    ];
    expect(groupTier4Weeks(recent, today)).toHaveLength(0);
  });
});

describe('readWeekSummaryCache', () => {
  it('maps cached rows by week_start', () => {
    cacheRows = [
      { week_start: '2026-01-05', item_count: 38, summary: 's1' },
      { week_start: '2025-12-29', item_count: 10, summary: null },
    ];
    const map = readWeekSummaryCache('u1');
    expect(map.get('2026-01-05')?.summary).toBe('s1');
    expect(map.get('2025-12-29')?.item_count).toBe(10);
  });
});

describe('writeWeekSummary', () => {
  it('upserts with the prompt version and the count it was generated against', () => {
    writeWeekSummary('u1', '2026-01-05', 38, '38 items · a good week');
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['user_id']).toBe('u1');
    expect(args['week_start']).toBe('2026-01-05');
    expect(args['item_count']).toBe(38);
    expect(args['summary']).toBe('38 items · a good week');
    expect(args['prompt_version']).toBe(WEEK_SUMMARY_PROMPT_VERSION);
  });

  it('stores null summary (guard failure / Gemma down) without dropping the row', () => {
    writeWeekSummary('u1', '2026-01-05', 38, null);
    const args = mockRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['summary']).toBeNull();
    expect(args['item_count']).toBe(38);
  });
});

describe('regenerateStaleWeekSummaries', () => {
  it('generates for stale weeks, upserts each, and reports counts', async () => {
    // One ≥30-day week with two titled rows; no cache → stale.
    feedRows = [
      { title: 'A', channel: 'C1', source: 'share_sheet', requested_at: '2026-01-05T10:00:00Z', added_at: '2026-01-05T10:00:00Z' },
      { title: 'B', channel: 'C2', source: 'recommended', requested_at: '2026-01-06T10:00:00Z', added_at: '2026-01-06T10:00:00Z' },
    ];
    vi.mocked(ollamaGenerate).mockResolvedValue('2 items · a quiet science week');

    const result = await regenerateStaleWeekSummaries('u1', { todayStr: '2026-03-01' });

    expect(result.staleCount).toBe(1);
    expect(result.generated).toBe(1);
    expect(result.nulled).toBe(0);
    expect(result.forced).toBe(false);
    // Upserted with the guarded summary.
    const upsert = mockRun.mock.calls.find(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'week_start' in (c[0] as Record<string, unknown>)
    );
    expect((upsert?.[0] as Record<string, unknown>)['summary']).toBe('2 items · a quiet science week');
  });

  it('stores null and counts it as nulled when Gemma is unreachable', async () => {
    feedRows = [
      { title: 'A', channel: 'C1', source: 'share_sheet', requested_at: '2026-01-05T10:00:00Z', added_at: '2026-01-05T10:00:00Z' },
    ];
    vi.mocked(ollamaGenerate).mockRejectedValue(new Error('Ollama unreachable'));

    const result = await regenerateStaleWeekSummaries('u1', { todayStr: '2026-03-01' });
    expect(result.staleCount).toBe(1);
    expect(result.generated).toBe(0);
    expect(result.nulled).toBe(1);
  });

  it('does nothing when there are no stale weeks (all recent)', async () => {
    feedRows = [
      { title: 'recent', channel: 'C', source: 'recommended', requested_at: '2026-02-25T10:00:00Z', added_at: '2026-02-25T10:00:00Z' },
    ];
    const result = await regenerateStaleWeekSummaries('u1', { todayStr: '2026-03-01' });
    expect(result.staleCount).toBe(0);
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });

  it('with force, regenerates a week whose cached count is unchanged (on-demand)', async () => {
    feedRows = [
      { title: 'A', channel: 'C1', source: 'share_sheet', requested_at: '2026-01-05T10:00:00Z', added_at: '2026-01-05T10:00:00Z' },
    ];
    // Cache already matches the current count of 1 → not stale, so the default
    // path would skip it; force must regenerate it anyway.
    cacheRows = [{ week_start: '2026-01-05', item_count: 1, summary: '1 items · old line' }];
    vi.mocked(ollamaGenerate).mockResolvedValue('1 items · a fresh take');

    const result = await regenerateStaleWeekSummaries('u1', { force: true, todayStr: '2026-03-01' });
    expect(result.forced).toBe(true);
    expect(result.staleCount).toBe(1);
    expect(result.generated).toBe(1);
    expect(vi.mocked(ollamaGenerate)).toHaveBeenCalledTimes(1);
  });

  it('without force, skips a week whose cached count is unchanged', async () => {
    feedRows = [
      { title: 'A', channel: 'C1', source: 'share_sheet', requested_at: '2026-01-05T10:00:00Z', added_at: '2026-01-05T10:00:00Z' },
    ];
    cacheRows = [{ week_start: '2026-01-05', item_count: 1, summary: '1 items · old line' }];

    const result = await regenerateStaleWeekSummaries('u1', { todayStr: '2026-03-01' });
    expect(result.staleCount).toBe(0);
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
  });
});
