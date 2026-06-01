import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inferChannelInterests } from './index';
import { SEARCH_TERMS_PENDING } from './reconcile';

vi.mock('../../config', () => ({
  config: { OLLAMA_URL: 'http://localhost:11434', OLLAMA_GUARD_MODEL: 'gemma4:e4b' },
}));

const { mockedWarn } = vi.hoisted(() => ({ mockedWarn: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: mockedWarn, error: vi.fn(), debug: vi.fn() },
}));

const { mockQueueAdd } = vi.hoisted(() => ({ mockQueueAdd: vi.fn() }));
vi.mock('../../queue', () => ({
  interestsQueue: { add: mockQueueAdd },
  guardQueue: { add: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

// Existing vocabulary the canonicalisation step matches against.
const vocabulary = [
  { id: 'minecraft', label: 'Minecraft', category: 'gaming' },
  { id: 'economics', label: 'Economics', category: null },
];

let existingLink: { 1: number } | undefined;
const interestInserts: Array<{ sql: string; args: unknown[] }> = [];
const channelLinkInserts: Array<{ sql: string; args: unknown[] }> = [];
// Models INSERT OR IGNORE: an id already present yields changes:0. Maps id ->
// label so the collision branch's "SELECT label" lookup works. Pre-seed to
// force a slug collision (same label => concurrent reuse; different => lossy).
const existingInterests = new Map<string, string>();

vi.mock('../../db/client', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((...gargs: unknown[]) => {
        if (sql.includes('FROM channel_interest_links')) return existingLink;
        if (sql.includes('label FROM interests')) {
          const id = gargs[0] as string;
          return existingInterests.has(id) ? { label: existingInterests.get(id) } : undefined;
        }
        return undefined;
      }),
      all: vi.fn(() => {
        if (sql.includes('FROM interests')) return vocabulary;
        return [];
      }),
      run: vi.fn((...args: unknown[]) => {
        if (sql.includes('INTO interests')) {
          interestInserts.push({ sql, args });
          const id = args[0] as string;
          if (existingInterests.has(id)) return { changes: 0 };
          existingInterests.set(id, args[1] as string);
          return { changes: 1 };
        }
        if (sql.includes('INTO channel_interest_links')) channelLinkInserts.push({ sql, args });
        return { changes: 1 };
      }),
    })),
  },
}));

import { ollamaGenerate } from '../../ollama';

// Sequence the two Gemma calls: describe (call 1), then canonicalise (call 2).
function gemma(describeJson: string, canonicaliseJson?: string): void {
  vi.mocked(ollamaGenerate).mockResolvedValueOnce(describeJson);
  if (canonicaliseJson !== undefined) {
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(canonicaliseJson);
  }
}

const linkedIds = (): unknown[] => channelLinkInserts.map((c) => c.args[1]);

beforeEach(() => {
  existingLink = undefined;
  interestInserts.length = 0;
  channelLinkInserts.length = 0;
  existingInterests.clear();
  mockedWarn.mockReset();
  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue(undefined);
  vi.mocked(ollamaGenerate).mockReset();
  // Default fetch: empty RSS so the prompt is built without titles.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<feed></feed>' })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inferChannelInterests', () => {
  it('exits early when the channel already has a link, without calling Gemma', async () => {
    existingLink = { 1: 1 };
    await inferChannelInterests('UC123', 'Some Channel');
    expect(vi.mocked(ollamaGenerate)).not.toHaveBeenCalled();
    expect(channelLinkInserts).toHaveLength(0);
    expect(interestInserts).toHaveLength(0);
  });

  it('canonicalises a free label onto an EXISTING interest and links it (no new row)', async () => {
    gemma('{"label":"minecraft survival"}', '{"match":"minecraft"}');
    await inferChannelInterests('UC123', 'SurvivalCraft');

    expect(interestInserts).toHaveLength(0); // matched — nothing created
    expect(linkedIds()).toEqual(['minecraft']);
    // Each link inserted at confidence 1.0.
    for (const c of channelLinkInserts) expect(c.sql).toContain('1.0');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('creates a new inferred interest on a genuine no-match, enqueues search-terms, links it', async () => {
    gemma('{"label":"fingerstyle guitar"}', '{"match":null}');
    await inferChannelInterests('UC123', 'Acoustic Lessons');

    expect(interestInserts).toHaveLength(1);
    expect(interestInserts[0]!.sql).toContain("'inferred'");
    expect(interestInserts[0]!.args[0]).toBe('fingerstyle_guitar'); // slug id
    expect(interestInserts[0]!.args[1]).toBe('fingerstyle guitar'); // free label
    expect(interestInserts[0]!.args[2]).toBe(SEARCH_TERMS_PENDING); // recoverable, not '[]'
    expect(linkedIds()).toEqual(['fingerstyle_guitar']);
    // Search-terms job enqueued for the new vocabulary, NOT as a kid-authored add.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0]![1]).toMatchObject({ isUserAdded: false, isKid: false });
  });

  it('does NOT force-fit: a hallucinated match id is treated as no-match and creates cleanly', async () => {
    // The old prompt forced a pick from the catalogue; the new flow must never
    // link an id that is not genuinely the same topic. A garbled/non-existent
    // match id falls through to create — it must not link 'economics' et al.
    gemma('{"label":"competitive pokemon"}', '{"match":"not_a_real_id"}');
    await inferChannelInterests('UC123', 'PokeBattles');

    expect(linkedIds()).toEqual(['competitive_pokemon']);
    expect(linkedIds()).not.toContain('economics');
    expect(interestInserts).toHaveLength(1);
  });

  it('mints a distinct id on an UNRELATED slug collision (lossy slugger)', async () => {
    // An unrelated interest already owns the lossy slug "c" (label "C"); a "c#"
    // channel must NOT link to or overwrite it — it gets a channel-stable id.
    existingInterests.set('c', 'C');
    gemma('{"label":"c#"}', '{"match":null}');
    await inferChannelInterests('UCsharp', 'C# Tutorials');

    const attemptedIds = interestInserts.map((i) => i.args[0]);
    expect(attemptedIds[0]).toBe('c');            // INSERT OR IGNORE — no-op
    expect(attemptedIds[1]).toBe('c_ucsharp');    // distinct, channel-stable
    expect(linkedIds()).toEqual(['c_ucsharp']);   // never linked the unrelated 'c'
  });

  it('reuses the existing row on a SAME-label slug collision (concurrent create, no fragmentation)', async () => {
    // Another follow inferred the same topic concurrently and created the row
    // first. The second call must reuse it (one shared id) rather than mint a
    // duplicate, so getInferredInterests aggregates them as one interest.
    existingInterests.set('speedcubing', 'speedcubing');
    gemma('{"label":"speedcubing"}', '{"match":null}');
    await inferChannelInterests('UCbbb', 'Cube Records');

    expect(interestInserts.map((i) => i.args[0])).toEqual(['speedcubing']); // no suffixed dup
    expect(linkedIds()).toEqual(['speedcubing']);
    expect(mockQueueAdd).not.toHaveBeenCalled(); // reused row already has a job in flight
  });

  it('inserts nothing when the channel topic is unclear (no second Gemma call)', async () => {
    gemma('{"label":null}');
    await inferChannelInterests('UC123', 'Vague Channel');

    expect(vi.mocked(ollamaGenerate)).toHaveBeenCalledTimes(1); // describe only
    expect(channelLinkInserts).toHaveLength(0);
    expect(interestInserts).toHaveLength(0);
  });

  it('inserts nothing and warns when canonicalisation is unparseable (no junk row)', async () => {
    gemma('{"label":"fingerstyle guitar"}', 'sorry, I cannot do that');
    await inferChannelInterests('UC456', 'Acoustic Lessons');

    expect(channelLinkInserts).toHaveLength(0);
    expect(interestInserts).toHaveLength(0);
    expect(mockedWarn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'UC456' }),
      'Channel interest inference: could not parse canonicalisation',
    );
  });

  it('collapses distinct free labels onto one shared id so aggregation holds', async () => {
    // Two Minecraft channels, two different free labels, both canonicalising to
    // `minecraft` → both links carry the same id. getInferredInterests then
    // aggregates them as one interest with followerCount 2 (see inferred.test).
    gemma('{"label":"minecraft survival"}', '{"match":"minecraft"}');
    await inferChannelInterests('UCaaa', 'SurvivalCraft');
    gemma('{"label":"MC redstone builds"}', '{"match":"minecraft"}');
    await inferChannelInterests('UCbbb', 'RedstoneWizard');

    expect(linkedIds()).toEqual(['minecraft', 'minecraft']);
    expect(interestInserts).toHaveLength(0);
  });
});
