import fs from 'fs';
import path from 'path';
import { db } from './client';
import { logger } from '../logger';

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT filename FROM migrations').all().map((r) => (r as { filename: string }).filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    logger.info({ migration: file }, 'Applying migration');

    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (filename, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString()
      );
    })();

    logger.info({ migration: file }, 'Migration applied');
  }
}
