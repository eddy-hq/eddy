import { db } from './client';
import { config } from '../config';
import { logger } from '../logger';

export function seedUsers(): void {
  const dailyPickCap = config.DEFAULT_DAILY_PICK_CAP;
  const users = [
    { user_id: config.USER_ID_STEVE, display_name: config.USER_NAME_STEVE, role: 'parent', age_gate: 1, birth_year: null, daily_pick_cap: dailyPickCap },
    { user_id: config.USER_ID_BOY1,  display_name: config.USER_NAME_BOY1,  role: 'kid',    age_gate: 0, birth_year: config.USER_BIRTH_YEAR_BOY1 ?? null, daily_pick_cap: dailyPickCap },
    { user_id: config.USER_ID_BOY2,  display_name: config.USER_NAME_BOY2,  role: 'kid',    age_gate: 0, birth_year: config.USER_BIRTH_YEAR_BOY2 ?? null, daily_pick_cap: dailyPickCap },
  ];

  // daily_pick_cap (ADR-0009): seed new users at the global default. A null
  // would still fall back to config.DEFAULT_DAILY_PICK_CAP at compose time,
  // but seeding the value keeps the row self-describing. Existing rows keep
  // whatever the migration backfilled / an admin later set — the upsert leaves
  // it untouched on conflict.
  const upsert = db.prepare(`
    INSERT INTO users (user_id, display_name, role, age_gate, birth_year, daily_pick_cap, profile, created_at)
    VALUES (@user_id, @display_name, @role, @age_gate, @birth_year, @daily_pick_cap, '{}', datetime('now'))
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
