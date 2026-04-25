#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run discovery:rescore [userId]
 *
 * Re-runs Gemma scoring against each user's existing candidate pool
 * without hitting yt-dlp. Intended for iterating on the scoring prompt:
 * tweak the prompt, run this, inspect the new scores. Only touches
 * candidates that haven't already been surfaced/dismissed/requested,
 * so the user-facing feed history is preserved.
 */
import 'dotenv/config';
import { runMigrations } from '../db/migrate';
import { seedUsers } from '../db/seed';
import { db } from '../db/client';
import { scoreCandidates } from '../modules/discovery/index';

runMigrations();
seedUsers();

const targetArg = process.argv[2] ?? null;

interface UserRow { user_id: string; role: string; age_gate: number; display_name: string; }
interface UserInterestRow {
  interest_id: string;
  label: string;
  rank: number;
  expertise: 'beginner' | 'comfortable' | 'deep';
  search_terms: string;
}

const users = (targetArg
  ? db.prepare(
      'SELECT user_id, role, age_gate, display_name FROM users WHERE user_id = ? OR lower(display_name) = lower(?)'
    ).all(targetArg, targetArg)
  : db.prepare("SELECT user_id, role, age_gate, display_name FROM users WHERE role IN ('kid','parent')").all()
) as UserRow[];

if (users.length === 0) {
  console.error('No users found', targetArg ? `for userId ${targetArg}` : '');
  process.exit(1);
}

async function main() {
  for (const user of users) {
    console.log(`\n── ${user.display_name} (${user.role}) ──────────────────────`);

    const interests = db.prepare(`
      SELECT ut.interest_id, t.label, ut.rank, ut.expertise, t.search_terms
      FROM user_interests ut
      INNER JOIN interests t ON t.id = ut.interest_id
      WHERE ut.user_id = ?
      ORDER BY ut.rank ASC
    `).all(user.user_id) as UserInterestRow[];

    if (interests.length === 0) {
      console.log('  No interests set, skipping');
      continue;
    }

    // Reset 'pending' and 'scored' candidates to pending so scoreCandidates
    // picks them up. Leave 'surfaced', 'dismissed', 'requested',
    // 'guard_pending', 'guard_rejected' alone — those represent decisions or
    // parent queue state. Keep guard_verdict so existing guard work is reused.
    const reset = db.prepare(`
      UPDATE candidate_pool
      SET status = 'pending', gemma_score = NULL, why_text = NULL, scored_at = NULL
      WHERE user_id = ?
        AND status IN ('pending', 'scored')
    `).run(user.user_id);

    console.log(`  Reset ${reset.changes} candidates to pending`);

    if (reset.changes === 0) {
      console.log('  Nothing to rescore — pool is empty or all candidates are final.');
      continue;
    }

    await scoreCandidates(user.user_id, interests);

    const scored = db.prepare(`
      SELECT c.title, c.connection_score, c.quality_score, c.why_text,
             c.published_at, c.interest_id, i.label AS interest_label
      FROM candidate_pool c
      LEFT JOIN interests i ON i.id = c.interest_id
      WHERE c.user_id = ? AND c.status = 'scored'
      ORDER BY (COALESCE(c.connection_score,0) * COALESCE(c.quality_score,0)) DESC
      LIMIT 30
    `).all(user.user_id) as Array<{
      title: string | null;
      connection_score: number | null;
      quality_score: number | null;
      why_text: string | null;
      published_at: string | null;
      interest_id: string | null;
      interest_label: string | null;
    }>;

    console.log(`\n  Top ${scored.length} by connection × quality:`);
    console.log(`  conn  qual  interest          title`);
    for (const r of scored) {
      const conn = (r.connection_score ?? 0).toFixed(1).padStart(4);
      const qual = (r.quality_score ?? 0).toFixed(1).padStart(4);
      const interest = (r.interest_label ?? '—').padEnd(16).slice(0, 16);
      const title = r.title ?? '(no title)';
      console.log(`  ${conn}  ${qual}  ${interest}  ${title}`);
      if (r.why_text) console.log(`               → ${r.why_text}`);
    }
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error('Rescore failed:', err);
  process.exit(1);
});
