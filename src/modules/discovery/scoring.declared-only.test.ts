import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression guard for the ADR-0008 scoring boundary (issue #158). The
// connection-axis vocabulary that feeds scoring is built from DECLARED
// interests only. An inferred-but-unkept interest (live-derived from follows
// via getInferredInterests, #156) is an inert proposal and MUST NEVER reach
// scoring. A kept inferred interest is already a declared `user_interests` row
// by the time it is scored, so it DOES appear. These tests pin that boundary
// so a future change to the derive path cannot silently wire inferred
// proposals into the scoring vocabulary or interestSummary.

vi.mock('../../config', () => ({
  config: {
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'gemma4:e4b',
    OLLAMA_GUARD_MODEL: 'gemma4:e4b',
  },
}));

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ollama')>()),
  ollamaGenerate: vi.fn(),
}));

const { guardAdd } = vi.hoisted(() => ({ guardAdd: vi.fn() }));
vi.mock('../../queue', () => ({
  redis: {},
  interestsQueue: { add: vi.fn() },
  guardQueue: { add: guardAdd },
  discoveryQueue: { add: vi.fn() },
  downloadQueue: { add: vi.fn() },
  thumbsQueue: { add: vi.fn() },
  deleteQueue: { add: vi.fn() },
  profileEnrichmentQueue: { add: vi.fn() },
  recyclerQueue: { add: vi.fn() },
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { ollamaGenerate } from '../../ollama';
import { scoreCandidates, buildScoringPrompt } from './scoring';
import { selectDeclaredInterests } from './index';
import { getInferredInterests, keepInferredInterest } from '../interests/inferred';

const USER_ID = '11111111-1111-7111-8111-111111111111';

// Two interests in the shared vocabulary. DECLARED is what the user typed;
// INFERRED is what would be derived from a follow but never Kept.
const DECLARED = 'robotics';
const INFERRED = 'minecraft';

const PERSON = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CHANNEL = 'UCaaa';

function follow(personId: string): void {
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, 1.0, ?, 'manual')
  `).run(USER_ID, personId, new Date().toISOString());
}

function link(channelId: string, interestId: string, confidence: number): void {
  db.prepare(`
    INSERT INTO channel_interest_links (channel_id, interest_id, confidence, inferred_at)
    VALUES (?, ?, ?, ?)
  `).run(channelId, interestId, confidence, new Date().toISOString());
}

function declare(interestId: string, rank: number): void {
  db.prepare(`
    INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
    VALUES (?, ?, ?, 'comfortable', 1, ?)
  `).run(USER_ID, interestId, rank, new Date().toISOString());
}

function insertCandidate(candidateId: string): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, person_id, interest_id,
       url, external_id, title, channel, duration_secs, status, created_at)
    VALUES (?, ?, 'video', 'interest_search', NULL, NULL, ?, ?, ?, 'channel', 600, 'pending', ?)
  `).run(
    candidateId, USER_ID,
    `https://www.youtube.com/watch?v=${candidateId}`,
    candidateId,
    `Title for ${candidateId}`,
    new Date().toISOString(),
  );
}

// Capture the prompt scoreCandidates hands to Gemma. interestSummary is the
// portion of that prompt built from the vocabulary, so asserting on the prompt
// is a behavioural assertion on what scoring actually sees.
function lastScoringPrompt(): string {
  const calls = vi.mocked(ollamaGenerate).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, now);

  db.prepare('INSERT INTO interests (id, label, category, search_terms, source) VALUES (?, ?, ?, ?, ?)')
    .run(DECLARED, 'Robotics', 'tech', '[]', 'user_added');
  db.prepare('INSERT INTO interests (id, label, category, search_terms, source) VALUES (?, ?, ?, ?, ?)')
    .run(INFERRED, 'Minecraft', 'gaming', '[]', 'user_added');

  db.prepare('INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)')
    .run(PERSON, 'Channel', 'creator', now);
  db.prepare(`
    INSERT INTO person_outputs (output_id, person_id, output_type, fetcher_type, external_id, active)
    VALUES (?, ?, 'youtube', 'rss', ?, 1)
  `).run(`out-${PERSON}`, PERSON, CHANNEL);
});

beforeEach(() => {
  db.exec('DELETE FROM followed_people');
  db.exec('DELETE FROM channel_interest_links');
  db.exec('DELETE FROM user_interests');
  db.exec('DELETE FROM inferred_interest_suppressions');
  db.exec('DELETE FROM candidate_pool');
  vi.clearAllMocks();
  guardAdd.mockResolvedValue(undefined);
});

describe('scoring vocabulary is declared-only (ADR-0008, #158)', () => {
  it('selectDeclaredInterests returns only declared user_interests, never inferred', () => {
    // A declared interest, plus a follow that WOULD infer a second interest.
    declare(DECLARED, 1);
    follow(PERSON);
    link(CHANNEL, INFERRED, 1.0);

    // Sanity: the inferred interest is genuinely derivable — the setup is real.
    expect(getInferredInterests(USER_ID).map((r) => r.interestId)).toEqual([INFERRED]);

    // The vocabulary that feeds scoring contains only the declared interest.
    const vocab = selectDeclaredInterests(USER_ID);
    expect(vocab.map((v) => v.interest_id)).toEqual([DECLARED]);
    expect(vocab.map((v) => v.interest_id)).not.toContain(INFERRED);
  });

  it('an inferred-but-unkept interest does NOT appear in interestSummary', async () => {
    declare(DECLARED, 1);
    follow(PERSON);
    link(CHANNEL, INFERRED, 1.0);
    insertCandidate('cand-1');

    // Inferred interest is derivable but never Kept.
    expect(getInferredInterests(USER_ID).map((r) => r.interestId)).toEqual([INFERRED]);

    vi.mocked(ollamaGenerate).mockResolvedValueOnce(
      '[{"index":1,"connection":5,"quality":5,"time_sensitivity":"standard","why":"ok"}]',
    );

    // Score with the vocabulary the production path would select.
    await scoreCandidates(USER_ID, selectDeclaredInterests(USER_ID));

    const prompt = lastScoringPrompt();
    expect(prompt).toContain('"Robotics"');
    expect(prompt).not.toContain('Minecraft');
  });

  it('a kept inferred interest (now a declared row) DOES appear in interestSummary', async () => {
    declare(DECLARED, 1);
    follow(PERSON);
    link(CHANNEL, INFERRED, 1.0);
    insertCandidate('cand-1');

    // Keep the inferred proposal — the human act that promotes it to a declared
    // user_interests row.
    keepInferredInterest(USER_ID, INFERRED);

    // It is no longer an inferred proposal: it is now declared.
    expect(getInferredInterests(USER_ID)).toEqual([]);
    const vocab = selectDeclaredInterests(USER_ID);
    expect(vocab.map((v) => v.interest_id)).toEqual([DECLARED, INFERRED]);

    vi.mocked(ollamaGenerate).mockResolvedValueOnce(
      '[{"index":1,"connection":5,"quality":5,"time_sensitivity":"standard","why":"ok"}]',
    );

    await scoreCandidates(USER_ID, vocab);

    const prompt = lastScoringPrompt();
    expect(prompt).toContain('"Robotics"');
    expect(prompt).toContain('"Minecraft"');
  });

  it('buildScoringPrompt only echoes the vocabulary it is handed (no inference reach-through)', () => {
    // The prompt builder is a pure function of its interestSummary argument: it
    // cannot reach into the inference path. Pinning this stops a future caller
    // from being the leak point.
    const vocab = [{
      interest_id: DECLARED, label: 'Robotics', rank: 1,
      expertise: 'comfortable' as const, search_terms: '[]',
    }];
    const interestSummary = vocab.map((t) => `"${t.label}" (${t.expertise})`).join(', ');

    const prompt = buildScoringPrompt(
      [{
        index: 1, candidateId: 'c1', title: 'X', channel: 'Y',
        durationSecs: null, publishedAt: null,
        interestLabel: null, expertise: null,
        sourceType: 'interest_search', personId: null, personName: null,
      }],
      interestSummary,
    );

    expect(prompt).toContain('"Robotics" (comfortable)');
    expect(prompt).not.toContain('Minecraft');
  });
});
