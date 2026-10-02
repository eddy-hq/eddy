import Database, { type Database as DatabaseType } from 'better-sqlite3';

// A read-only connection for offline tooling that must never write (the guard
// harness snapshot). Separate from client.ts on purpose: importing client.ts
// opens the shared writable connection, and a missing DATABASE_PATH would be
// created by it. This opens nothing until called, and fails rather than
// creating a missing file. The app itself uses client.ts only.
export function openReadOnlyDatabase(path: string): DatabaseType {
  const ro = new Database(path, { readonly: true, fileMustExist: true });
  ro.pragma('busy_timeout = 5000');
  return ro;
}
