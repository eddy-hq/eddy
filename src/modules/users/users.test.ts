import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ValidationError, NotFoundError } from '../../errors';

vi.mock('../../db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memoryDb = new Database(':memory:');
  memoryDb.exec(`
    CREATE TABLE users (
      user_id      TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role         TEXT NOT NULL,
      age_gate     INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { db: memoryDb };
});

import { db } from '../../db/client';
import { resolveUserById, resolveUserByIdOrName } from './index';

const BOY1_ID = '11111111-1111-7111-8111-111111111111';
const PARENT_ID = '22222222-2222-7222-8222-222222222222';

beforeEach(() => {
  db.exec('DELETE FROM users');
  const insert = db.prepare(
    'INSERT INTO users (user_id, display_name, role, age_gate) VALUES (?, ?, ?, ?)'
  );
  insert.run(BOY1_ID, 'Boy1', 'kid', 12);
  insert.run(PARENT_ID, 'Steve', 'parent', 0);
});

describe('resolveUserById', () => {
  it('returns the canonical UserRow for a valid UUID', () => {
    expect(resolveUserById(BOY1_ID)).toEqual({
      user_id: BOY1_ID,
      display_name: 'Boy1',
      role: 'kid',
      age_gate: 12,
    });
  });

  // Load-bearing: pins down the policy boundary that PWA-only endpoints
  // must not accept display-names — even when one would otherwise match.
  it('rejects a display-name that exists in the table', () => {
    expect(() => resolveUserById('Boy1')).toThrow(NotFoundError);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['number', 123],
    ['null', null],
  ])('throws ValidationError for %s input', (_label, value) => {
    expect(() => resolveUserById(value)).toThrow(ValidationError);
  });

  it('throws NotFoundError for an unknown id', () => {
    expect(() => resolveUserById('99999999-9999-7999-8999-999999999999')).toThrow(NotFoundError);
  });
});

describe('resolveUserByIdOrName', () => {
  it('returns the canonical UserRow for a valid UUID', () => {
    const row = resolveUserByIdOrName(BOY1_ID);
    expect(row.user_id).toBe(BOY1_ID);
    expect(row.display_name).toBe('Boy1');
  });

  it('returns the canonical UserRow for a display-name (case-insensitive)', () => {
    const row = resolveUserByIdOrName('BOY1');
    expect(row.user_id).toBe(BOY1_ID);
    expect(row.display_name).toBe('Boy1');
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['number', 42],
    ['null', null],
  ])('throws ValidationError for %s input', (_label, value) => {
    expect(() => resolveUserByIdOrName(value)).toThrow(ValidationError);
  });

  it('throws NotFoundError when neither id nor name matches', () => {
    expect(() => resolveUserByIdOrName('NotARealName')).toThrow(NotFoundError);
  });

  // A display-name that happens to look like a UUID must still resolve via
  // the display-name branch — the OR-query handles this without a regex sniff.
  it('falls through to display-name match for a UUID-shaped string that is not a real user_id', () => {
    const fakeUuid = '12345678-1234-1234-1234-123456789012';
    db.prepare(
      'INSERT INTO users (user_id, display_name, role, age_gate) VALUES (?, ?, ?, ?)'
    ).run('33333333-3333-7333-8333-333333333333', fakeUuid, 'kid', 10);

    const row = resolveUserByIdOrName(fakeUuid);
    expect(row.user_id).toBe('33333333-3333-7333-8333-333333333333');
    expect(row.display_name).toBe(fakeUuid);
  });
});
