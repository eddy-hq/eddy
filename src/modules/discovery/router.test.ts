import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  return { db: memoryDb };
});

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../requests', () => ({
  getRequestsState: vi.fn(() => ({
    apply: vi.fn(() => ({ result: { transitioned: true, userId: '' }, settled: Promise.resolve() })),
  })),
}));

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { hasRecentBalancePrompt } from './router';

const USER_ID = '11111111-1111-7111-8111-111111111111';
const INTEREST_ID = '22222222-2222-7222-8222-222222222222';

beforeAll(() => {
  runMigrations();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(USER_ID, 'Boy1', 'kid', 12, new Date().toISOString());
  db.prepare(
    'INSERT INTO interests (id, label, search_terms, source) VALUES (?, ?, ?, ?)',
  ).run(INTEREST_ID, 'Robotics', '[]', 'user_added');
});

beforeEach(() => {
  db.exec('DELETE FROM balance_prompts');
  db.exec('DELETE FROM candidate_pool');
});

describe('discovery feed balance prompt cooldown', () => {
  it('ignores a same-cutoff-day prompt that is earlier than the cutoff time', () => {
    const cutoff = db.prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') AS cutoff",
    ).get() as { cutoff: string };
    const shownAt = new Date(new Date(cutoff.cutoff).getTime() - 60_000).toISOString();
    expect(shownAt.slice(0, 10)).toBe(cutoff.cutoff.slice(0, 10));

    db.prepare(`
      INSERT INTO balance_prompts
        (prompt_id, user_id, interest_id, interest_label, concentration, shown_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('prompt-1', USER_ID, INTEREST_ID, 'Robotics', 1, shownAt);

    expect(hasRecentBalancePrompt(USER_ID, INTEREST_ID)).toBe(false);
  });
});
