import 'dotenv/config';
import { db } from '../db/client';
import { logger } from '../logger';
import {
  recomputeBehaviouralSnapshot,
  recomputeTrustWeights,
} from '../modules/profile-enrichment';

// Replays existing watch_events plus current candidate_pool.status='dismissed'
// rows so trust weights take effect immediately on rollout (issue #58), not
// after weeks of fresh data. Idempotent — re-running rebuilds the snapshot in
// place and rewrites followed_people.trust_weight, so partial runs are safe.

interface UserRow {
  user_id: string;
  role: string;
}

function run(): void {
  const users = db.prepare(
    "SELECT user_id, role FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  let totalPersons = 0;
  let totalTrust = 0;
  for (const user of users) {
    const persons = recomputeBehaviouralSnapshot(user.user_id);
    const trust = recomputeTrustWeights(user.user_id);
    totalPersons += persons;
    totalTrust += trust;
    logger.info(
      { userId: user.user_id, role: user.role, personsInSnapshot: persons, trustApplied: trust },
      'Trust backfill: user complete'
    );
  }

  logger.info({ users: users.length, totalPersons, totalTrust }, 'Trust backfill complete');
}

try {
  run();
  process.exit(0);
} catch (err) {
  logger.error({ err }, 'Trust backfill failed');
  process.exit(1);
}
