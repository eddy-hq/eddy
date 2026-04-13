import { db } from './client';
import { config } from '../config';
import { logger } from '../logger';

export function seedUsers(): void {
  const users = [
    { user_id: config.USER_ID_STEVE, display_name: config.USER_NAME_STEVE, role: 'parent', age_gate: 1 },
    { user_id: config.USER_ID_SON1,  display_name: config.USER_NAME_SON1,  role: 'kid',    age_gate: 0 },
    { user_id: config.USER_ID_SON2,  display_name: config.USER_NAME_SON2,  role: 'kid',    age_gate: 0 },
  ];

  const upsert = db.prepare(`
    INSERT INTO users (user_id, display_name, role, age_gate, profile, created_at)
    VALUES (@user_id, @display_name, @role, @age_gate, '{}', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name
  `);

  const runAll = db.transaction(() => {
    for (const user of users) {
      upsert.run(user);
    }
  });

  runAll();
  logger.info({ count: users.length }, 'Users seeded');
}
