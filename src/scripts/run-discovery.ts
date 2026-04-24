#!/usr/bin/env tsx
/**
 * npm run discovery:run [userId]
 *
 * Runs the discovery engine for all users, or a single user if userId is provided.
 * Outputs what was found, scored, and surfaced.
 */
import 'dotenv/config';
import { runMigrations } from '../db/migrate';
import { seedUsers } from '../db/seed';
import { db } from '../db/client';
import { runDiscoveryForUser } from '../modules/discovery/index';

runMigrations();
seedUsers();

const targetArg = process.argv[2] ?? null;

interface UserRow { user_id: string; role: string; age_gate: number; display_name: string; }

const users = (targetArg
  ? db.prepare(
      'SELECT user_id, role, age_gate, display_name FROM users WHERE user_id = ? OR lower(display_name) = lower(?)'
    ).all(targetArg, targetArg)
  : db.prepare("SELECT user_id, role, age_gate, display_name FROM users WHERE role IN ('kid','parent')").all()
) as UserRow[];

if (users.length === 0) {
  // eslint-disable-next-line no-console
  console.error('No users found', targetArg ? `for userId ${targetArg}` : '');
  process.exit(1);
}

async function main() {
  for (const user of users) {
    // eslint-disable-next-line no-console
    console.log(`\n── ${user.display_name} (${user.role}) ──────────────────────`);
    const result = await runDiscoveryForUser(user);

    if (result.skipped) {
      // eslint-disable-next-line no-console
      console.log(`  Skipped: ${result.skipReason}`);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`  Interests checked: ${result.interestsChecked}`);
    // eslint-disable-next-line no-console
    console.log(`  Candidates added: ${result.candidatesAdded}`);
    // eslint-disable-next-line no-console
    console.log(`  Surfaced today : ${result.surfaced}`);

    if (result.items.length === 0) {
      // eslint-disable-next-line no-console
      console.log('  No items surfaced.');
      continue;
    }

    // eslint-disable-next-line no-console
    console.log('\n  Surfaced items:');
    for (const item of result.items) {
      const score = item.score !== null ? item.score.toFixed(1) : '?';
      const guard = item.guardVerdict ? ` [${item.guardVerdict}]` : '';
      // eslint-disable-next-line no-console
      console.log(`  ${score}${guard}  ${item.title ?? '(no title)'}`);
      if (item.why) {
        // eslint-disable-next-line no-console
        console.log(`         → ${item.why}`);
      }
    }
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Discovery run failed:', err);
  process.exit(1);
});
