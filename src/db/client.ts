import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config';

// Single shared DB connection for the process.
// All repository functions import from here — never instantiate Database directly.
export const db: DatabaseType = new Database(config.DATABASE_PATH);

// Performance defaults
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// A separate read-only connection, for offline tooling that must never write
// (the guard harness snapshot). Fails rather than creating a missing file.
export function openReadOnlyDatabase(path: string): DatabaseType {
  const ro = new Database(path, { readonly: true, fileMustExist: true });
  ro.pragma('busy_timeout = 5000');
  return ro;
}
