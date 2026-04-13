import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config';

// Single shared DB connection for the process.
// All repository functions import from here — never instantiate Database directly.
export const db: DatabaseType = new Database(config.DATABASE_PATH);

// Performance defaults
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
