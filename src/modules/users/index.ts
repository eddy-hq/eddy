import { db } from '../../db/client';
import { ValidationError, NotFoundError } from '../../errors';

export interface UserRow {
  user_id: string;
  display_name: string;
  role: string;
  age_gate: number;
}

const SELECT_COLUMNS = 'user_id, display_name, role, age_gate';

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
