import { db } from './client';
import { config } from '../config';
import { logger } from '../logger';

export function seedUsers(): void {
  const users = [
    { user_id: config.USER_ID_STEVE, display_name: config.USER_NAME_STEVE, role: 'parent', age_gate: 1, birth_year: null },
    { user_id: config.USER_ID_BOY1,  display_name: config.USER_NAME_BOY1,  role: 'kid',    age_gate: 0, birth_year: config.USER_BIRTH_YEAR_BOY1 ?? null },
    { user_id: config.USER_ID_BOY2,  display_name: config.USER_NAME_BOY2,  role: 'kid',    age_gate: 0, birth_year: config.USER_BIRTH_YEAR_BOY2 ?? null },
  ];

  const upsert = db.prepare(`
    INSERT INTO users (user_id, display_name, role, age_gate, birth_year, profile, created_at)
    VALUES (@user_id, @display_name, @role, @age_gate, @birth_year, '{}', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      birth_year = COALESCE(excluded.birth_year, users.birth_year)
  `);

  const runAll = db.transaction(() => {
    for (const user of users) {
      upsert.run(user);
    }
  });

  runAll();
  logger.info({ count: users.length }, 'Users seeded');
}
