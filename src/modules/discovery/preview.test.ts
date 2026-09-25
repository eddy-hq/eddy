import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { DEFAULT_DAILY_PICK_CAP: 15 },
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

import { db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { renderPreviewHtml } from './preview';
import { kidGuardClause } from './surface';

const KID_USER_ID = '11111111-1111-7111-8111-111111111111';
const ADULT_USER_ID = '22222222-2222-7222-8222-222222222222';

function insertCandidate(candidateId: string, userId: string, guardVerdict: string | null, title: string): void {
  db.prepare(`
    INSERT INTO candidate_pool
      (candidate_id, user_id, content_type, source_type, url, external_id, title,
       connection_score, quality_score, time_sensitivity, published_at,
       guard_verdict, status, created_at, why_text)
    VALUES (?, ?, 'video', 'interest_search', ?, ?, ?, 8, 8, 'evergreen', ?, ?, 'scored', ?, ?)
  `).run(
    candidateId,
    userId,
    `https://www.youtube.com/watch?v=${candidateId}`,
    candidateId,
    title,
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    guardVerdict,
    new Date().toISOString(),
    'Because it matches your interests.',
  );
}

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(KID_USER_ID, 'Boy1', 'kid', 12, now);
  db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(ADULT_USER_ID, 'Parent1', 'parent', 0, now);
});

beforeEach(() => {
  db.exec('DELETE FROM candidate_pool');
});

describe('kidGuardClause', () => {
  it('requires an explicit clear_yes for kids and admits nothing unguarded', () => {
    expect(kidGuardClause(true)).toContain("AND c.guard_verdict = 'clear_yes'");
    expect(kidGuardClause(true)).not.toMatch(/guard_verdict IS NULL/);
  });

  it('keeps Blocked channels out of a kid surface', () => {
    expect(kidGuardClause(true)).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM blocked_channels/);
  });

  it('adds no guard filter for adults', () => {
    expect(kidGuardClause(false)).toBe('');
  });
});

describe('discovery preview guard filter', () => {
  it('matches surfacing: a kid preview omits never-guarded candidates', () => {
    insertCandidate('cand-cleared', KID_USER_ID, 'clear_yes', 'Placeholder cleared candidate');
    insertCandidate('cand-unguarded', KID_USER_ID, null, 'Placeholder unguarded candidate');

    const html = renderPreviewHtml(KID_USER_ID);
    expect(html).toContain('Placeholder cleared candidate');
    expect(html).not.toContain('Placeholder unguarded candidate');
  });

  it('leaves an adult preview unfiltered by guard verdict', () => {
    insertCandidate('cand-adult-cleared', ADULT_USER_ID, 'clear_yes', 'Placeholder adult cleared');
    insertCandidate('cand-adult-unguarded', ADULT_USER_ID, null, 'Placeholder adult unguarded');

    const html = renderPreviewHtml(ADULT_USER_ID);
    expect(html).toContain('Placeholder adult cleared');
    expect(html).toContain('Placeholder adult unguarded');
  });
});
