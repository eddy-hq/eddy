import { db } from '../../db/client';
import { ValidationError, NotFoundError } from '../../errors';
import { logger } from '../../logger';

export interface UserRow {
  user_id: string;
  display_name: string;
  role: string;
  age_gate: number;
  birth_year: number | null;
}

const SELECT_COLUMNS = 'user_id, display_name, role, age_gate, birth_year';
const DEFAULT_AGE_BAND = 'under 10';
const warnedMissingAgeBandUserIds = new Set<string>();

function bandForAge(age: number): string {
  if (age < 10) return 'under 10';
  if (age <= 12) return '10-12';
  if (age <= 15) return '13-15';
  if (age <= 17) return '16-17';
  return '18+';
}

export function getAgeBand(userId: string): string {
  const row = db.prepare(
    'SELECT birth_year FROM users WHERE user_id = ?'
  ).get(userId) as { birth_year: number | null } | undefined;

  // birth_year is a typed column because the guard prompt depends on this
  // safety datum; unknown ages use the most restrictive prompt band.
  if (row?.birth_year == null) {
    if (!warnedMissingAgeBandUserIds.has(userId)) {
      warnedMissingAgeBandUserIds.add(userId);
      logger.warn({ userId }, 'User birth year missing; using most restrictive guard age band');
    }
    return DEFAULT_AGE_BAND;
  }

  // With birth year only, this is a coarse age estimate, not exact age.
  const age = new Date().getUTCFullYear() - row.birth_year;
  if (!Number.isFinite(age) || age < 0) {
    logger.warn({ userId, birthYear: row.birth_year }, 'User birth year invalid; using most restrictive guard age band');
    return DEFAULT_AGE_BAND;
  }

  return bandForAge(age);
}

// UUID-only lookup. Use for endpoints that are NOT reachable from the iOS
// Shortcut share-sheet path — display-name is guessable, UUID isn't, so this
// is the security-relevant default for PWA-only routes.
export function resolveUserById(id: unknown): UserRow {
  if (typeof id !== 'string' || !id.trim()) throw new ValidationError('userId required');
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE user_id = ?`
  ).get(id) as UserRow | undefined;
  if (!row) throw new NotFoundError(`user ${id}`);
  return row;
}

// UUID-or-display-name lookup. Use only for endpoints reachable from the iOS
// Shortcut share-sheet path, where the kid types their own name. Single
// OR-query avoids the edge case where a display-name happens to be UUID-shaped.
export function resolveUserByIdOrName(value: unknown): UserRow {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('userId required');
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE user_id = ? OR lower(display_name) = lower(?)`
  ).get(value, value) as UserRow | undefined;
  if (!row) throw new NotFoundError(`user ${value}`);
  return row;
}
