import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { ollamaGenerate } from '../../ollama';
import { scoreCandidates } from './scoring';
import type { UserInterestRow } from './intake';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const INTEREST_ID = '22222222-2222-7222-8222-222222222222';
const PERSON_TRUSTED = '33333333-3333-7333-8333-333333333aaa';
const PERSON_DISTRUSTED = '33333333-3333-7333-8333-333333333bbb';

const INTERESTS: UserInterestRow[] = [{
  interest_id: INTEREST_ID,
  label: 'robotics',
  rank: 1,
  expertise: 'comfortable',
  search_terms: '[]',
}];

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO interests (id, label, search_terms, source) VALUES (?, ?, ?, ?)',
  ).run(INTEREST_ID, 'robotics', '[]', 'user_added');
  db.prepare(
    'INSERT INTO user_interests (user_id, interest_id, rank, expertise, added_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, INTEREST_ID, 1, 'comfortable', new Date().toISOString());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON_TRUSTED, 'Trusted Person', 'individual', new Date().toISOString());
  db.prepare(
    'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(PERSON_DISTRUSTED, 'Distrusted Person', 'individual', new Date().toISOString());
  // 1.5× — fully trusted
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, ?, ?, 'manual')
  `).run(USER_ID, PERSON_TRUSTED, 1.5, new Date().toISOString());
  // 0.5× — fully distrusted
  db.prepare(`
    INSERT INTO followed_people (user_id, person_id, trust_weight, followed_at, followed_via)
    VALUES (?, ?, ?, ?, 'manual')
  `).run(USER_ID, PERSON_DISTRUSTED, 0.5, new Date().toISOString());
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
  vi.clearAllMocks();
});

function insertCandidate(opts: {
  candidate_id: string;
  source_type: 'person_backcatalog' | 'interest_search';
  person_id: string | null;
  interest_id?: string | null;
}): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, person_id, interest_id,
       url, external_id, title, channel, duration_secs,
       status, created_at)
    VALUES (?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    opts.candidate_id, USER_ID, opts.source_type,
    opts.person_id, opts.interest_id ?? INTEREST_ID,
    `https://www.youtube.com/watch?v=${opts.candidate_id}`,
    opts.candidate_id,
    `Title for ${opts.candidate_id}`,
    'channel',
    600,
    new Date().toISOString(),
  );
}

function readScored(candidateId: string): { connection_score: number; quality_score: number } {
  return db.prepare(
    'SELECT connection_score, quality_score FROM candidate_pool WHERE candidate_id = ?'
  ).get(candidateId) as { connection_score: number; quality_score: number };
}

describe('scoreCandidates trust multiplier', () => {
  it('multiplies connection by trust_weight for person-sourced candidates', async () => {
    insertCandidate({
      candidate_id: 'pers-trust', source_type: 'person_backcatalog',
      person_id: PERSON_TRUSTED,
    });
    // Gemma response: connection=6, quality=8. After 1.5× trust → 9, 8.
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(
      '[{"index":1,"connection":6,"quality":8,"time_sensitivity":"standard","why":"ok"}]'
    );

    await scoreCandidates(USER_ID, INTERESTS);

    const row = readScored('pers-trust');
    expect(row.connection_score).toBeCloseTo(9, 5);
    expect(row.quality_score).toBe(8);
  });

  it('applies the 0.5 multiplier to a distrusted person', async () => {
    insertCandidate({
      candidate_id: 'pers-dist', source_type: 'person_backcatalog',
      person_id: PERSON_DISTRUSTED,
    });
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(
      '[{"index":1,"connection":8,"quality":7,"time_sensitivity":"standard","why":"ok"}]'
    );

    await scoreCandidates(USER_ID, INTERESTS);

    const row = readScored('pers-dist');
    expect(row.connection_score).toBeCloseTo(4, 5);
    expect(row.quality_score).toBe(7);
  });

  it('leaves interest_search candidates (person_id NULL) untouched', async () => {
    insertCandidate({
      candidate_id: 'int-search', source_type: 'interest_search',
      person_id: null,
    });
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(
      '[{"index":1,"connection":7,"quality":6,"time_sensitivity":"standard","why":"ok"}]'
    );

    await scoreCandidates(USER_ID, INTERESTS);

    const row = readScored('int-search');
    expect(row.connection_score).toBe(7);
    expect(row.quality_score).toBe(6);
  });

  it('falls back to 1.0 when the person is unfollowed (no followed_people row)', async () => {
    const unknownPerson = '99999999-9999-7999-8999-999999999999';
    db.prepare(
      'INSERT INTO people (person_id, display_name, person_type, created_at) VALUES (?, ?, ?, ?)',
    ).run(unknownPerson, 'Unknown', 'individual', new Date().toISOString());
    insertCandidate({
      candidate_id: 'pers-unknown', source_type: 'person_backcatalog',
      person_id: unknownPerson,
    });
    vi.mocked(ollamaGenerate).mockResolvedValueOnce(
      '[{"index":1,"connection":5,"quality":5,"time_sensitivity":"standard","why":"ok"}]'
    );

    await scoreCandidates(USER_ID, INTERESTS);

    const row = readScored('pers-unknown');
    expect(row.connection_score).toBe(5);
    expect(row.quality_score).toBe(5);
  });
});
