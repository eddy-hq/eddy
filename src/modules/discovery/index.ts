import { Worker } from 'bullmq';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { redis, discoveryQueue } from '../../queue';
import { evaluateCandidate } from '../guard/index';
import { refreshCandidatePool, seedBackCatalogCandidates, type UserInterestRow } from './intake';
import { scoreCandidates } from './scoring';
import {
  surfaceForToday,
  freshnessMultiplier,
  rankWeight,
  readScoredCandidates,
  updateCandidatePoolStatus,
} from './surface';

interface UserRow {
  user_id: string;
  role: string;
  age_gate: number;
}

export interface DiscoveryRunResult {
  userId: string;
  skipped: boolean;
  skipReason?: string;
  interestsChecked: number;
  candidatesAdded: number;
  surfaced: number;
  items: Array<{ title: string | null; score: number | null; why: string | null; guardVerdict: string | null }>;
}

// Top-N scored candidates re-checked through the guard for kid users.
const KID_GUARD_RECHECK_LIMIT = 30;

export async function runDiscoveryForUser(user: UserRow, options: { force?: boolean } = {}): Promise<DiscoveryRunResult> {
  const today = new Date().toISOString().slice(0, 10);
  const isKid = user.role === 'kid';
  const cap = isKid ? 5 : 15;

  const existing = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool WHERE user_id = ? AND surfaced_date = ?
  `).get(user.user_id, today) as { n: number };

  if (existing.n >= cap && !options.force) {
    logger.info({ userId: user.user_id }, 'Discovery: already at cap for today, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'Already at daily cap (use --force to override)', interestsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  const userInterests = db.prepare(`
    SELECT ut.interest_id, t.label, ut.rank, ut.expertise, t.search_terms
    FROM user_interests ut
    INNER JOIN interests t ON t.id = ut.interest_id
    WHERE ut.user_id = ?
    ORDER BY ut.rank ASC
  `).all(user.user_id) as UserInterestRow[];

  if (userInterests.length === 0) {
    logger.info({ userId: user.user_id }, 'Discovery: user has no interests, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'No interests set', interestsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  logger.info({ userId: user.user_id, interests: userInterests.length }, 'Discovery: refreshing candidate pool');
  const interestSearchAdded = await refreshCandidatePool(user.user_id, userInterests);
  logger.info({ userId: user.user_id, added: interestSearchAdded }, 'Discovery: interest-search candidates added');

  const backCatalogAdded = await seedBackCatalogCandidates(user.user_id);
  logger.info({ userId: user.user_id, added: backCatalogAdded }, 'Discovery: back-catalog candidates added');

  const added = interestSearchAdded + backCatalogAdded;

  await scoreCandidates(user.user_id, userInterests);

  if (isKid) {
    const scored = readScoredCandidates(user.user_id, KID_GUARD_RECHECK_LIMIT);
    for (const c of scored) {
      const verdict = await evaluateCandidate({
        candidateId: c.candidate_id,
        userId: user.user_id,
        url: c.url,
        title: c.title ?? '',
      });

      const nextStatus = verdict.verdict === 'clear_yes' ? 'scored'
        : verdict.verdict === 'clear_no' ? 'guard_rejected'
        : 'guard_pending';

      updateCandidatePoolStatus(c.candidate_id, verdict.verdict, nextStatus);
    }
  }

  const surfaced = surfaceForToday(user.user_id, isKid);
  logger.info({ userId: user.user_id, surfaced }, 'Discovery: surfaced for today');

  const items = db.prepare(`
    SELECT c.title, c.gemma_score, c.connection_score, c.quality_score,
           c.time_sensitivity, c.why_text, c.guard_verdict, c.published_at,
           c.interest_id, COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.surfaced_date = ?
  `).all(user.user_id, today) as Array<{
    title: string | null;
    gemma_score: number | null;
    connection_score: number | null;
    quality_score: number | null;
    time_sensitivity: string | null;
    why_text: string | null;
    guard_verdict: string | null;
    published_at: string | null;
    interest_id: string | null;
    rank: number;
  }>;

  const sortedItems = items
    .map((r) => ({
      row: r,
      weighted: (r.connection_score ?? 0)
        * (r.quality_score ?? 0)
        * freshnessMultiplier(r.published_at, r.time_sensitivity)
        * rankWeight(r.rank),
    }))
    .sort((a, b) => b.weighted - a.weighted)
    .map((x) => x.row);

  return {
    userId: user.user_id,
    skipped: false,
    interestsChecked: userInterests.length,
    candidatesAdded: added,
    surfaced,
    items: sortedItems.map((r) => ({ title: r.title, score: r.gemma_score, why: r.why_text, guardVerdict: r.guard_verdict })),
  };
}

function pruneStalePool(): void {
  const result = db.prepare(`
    DELETE FROM candidate_pool
    WHERE status = 'pending' AND created_at < datetime('now', '-30 days')
  `).run();
  if (result.changes > 0) {
    logger.info({ deleted: result.changes }, 'Discovery: pruned stale candidates');
  }
}

async function runDiscovery(): Promise<void> {
  logger.info('Discovery job started');

  const users = db.prepare(
    "SELECT user_id, role, age_gate FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  for (const user of users) {
    await runDiscoveryForUser(user).catch((err: unknown) => {
      logger.error({ err, userId: user.user_id }, 'Discovery: user run failed');
    });
  }

  pruneStalePool();
  logger.info('Discovery job complete');
}

let discoveryWorker: Worker | null = null;

export function startDiscoveryScheduler(): void {
  void discoveryQueue.add('run', {}, {
    repeat: { pattern: '0 6 * * *' },
    jobId: 'discovery-daily',
  }).catch((err: unknown) => logger.warn({ err }, 'Discovery: failed to schedule repeatable job'));

  discoveryWorker = new Worker('discovery', async (job) => {
    if (job.name === 'run') await runDiscovery();
  }, { connection: redis, concurrency: 1 });

  discoveryWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Discovery job completed');
  });
  discoveryWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Discovery job failed');
  });

  logger.info('Discovery scheduler started (daily at 06:00)');
}

export async function stopDiscoveryScheduler(): Promise<void> {
  if (discoveryWorker) {
    await discoveryWorker.close();
    discoveryWorker = null;
  }
}

// Re-exports kept for scripts/preview that import from the discovery barrel.
export { scoreCandidates } from './scoring';
export { MIN_CONNECTION_SCORE, MIN_QUALITY_SCORE, MIN_WEIGHTED_SCORE } from './scoring';
export { freshnessMultiplier, rankWeight, allocateSlots } from './surface';
export type { AllocatableItem } from './surface';
export { discoveryRouter } from './router';
