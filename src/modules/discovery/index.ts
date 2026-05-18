import { Worker } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { redis, discoveryQueue } from '../../queue';
import { evaluateCandidate } from '../guard/index';
import { getRequestsState } from '../requests';
import { getAgeBand } from '../users';
import {
  refreshCandidatePool,
  seedBackCatalogCandidates,
  countPersonSourcedForRefresh,
  type UserInterestRow,
} from './intake';
import { scoreCandidates } from './scoring';
import {
  surfaceForToday,
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

  // Person-sourced primary, interest search as gap-filler (brief §17, issue
  // #149). Seed the back catalog first so the count of person-sourced
  // material reflects what's actually available this refresh; the interest-
  // search budget is then scaled to the deficit (or skipped entirely when
  // the person supply already meets the daily slate cap).
  logger.info({ userId: user.user_id, interests: userInterests.length }, 'Discovery: refreshing candidate pool');

  const backCatalogAdded = await seedBackCatalogCandidates(user.user_id);
  logger.info({ userId: user.user_id, added: backCatalogAdded }, 'Discovery: back-catalog candidates added');

  const personSourcedCount = countPersonSourcedForRefresh(user.user_id);
  const threshold = isKid
    ? config.DISCOVERY_PERSON_SOURCED_THRESHOLD_KID
    : config.DISCOVERY_PERSON_SOURCED_THRESHOLD_ADULT;
  const interestSearchAdded = await refreshCandidatePool(user.user_id, userInterests, {
    personSourcedCount,
    threshold,
  });
  logger.info({ userId: user.user_id, added: interestSearchAdded }, 'Discovery: interest-search candidates added');

  const added = interestSearchAdded + backCatalogAdded;

  await scoreCandidates(user.user_id, userInterests);

  if (isKid) {
    const ageBand = getAgeBand(user.user_id);
    const scored = readScoredCandidates(user.user_id, KID_GUARD_RECHECK_LIMIT);
    for (const c of scored) {
      const verdict = await evaluateCandidate({
        candidateId: c.candidate_id,
        userId: user.user_id,
        url: c.url,
        title: c.title ?? '',
        ageBand,
      });

      const nextStatus = verdict.verdict === 'clear_yes' ? 'scored'
        : verdict.verdict === 'clear_no' ? 'guard_rejected'
        : 'guard_pending';

      updateCandidatePoolStatus(c.candidate_id, verdict.verdict, nextStatus);
    }
  }

  const verdicts = surfaceForToday(user.user_id, isKid);
  const picks = verdicts.filter((v) => v.disposition === 'regular' || v.disposition === 'stretch');
  logger.info({ userId: user.user_id, surfaced: picks.length }, 'Discovery: surfaced for today');

  // Picks land in the feed directly — no separate accept step. Mirror the
  // historical /discovery/request flow: create a request via the state
  // machine (inserts a `recommended` row with status=downloading + why_text
  // and enqueues the download), then flip the candidate_pool row to
  // 'requested' so the brief day-cap accounting holds.
  const requestsState = getRequestsState();
  const markRequested = db.prepare(
    `UPDATE candidate_pool SET status = 'requested' WHERE candidate_id = ?`,
  );
  await Promise.all(picks.map(async (v) => {
    if (!v.candidate.url) {
      logger.warn(
        { userId: user.user_id, candidateId: v.candidate.candidateId },
        'Discovery: pick has no URL, skipping auto-create',
      );
      return;
    }
    const requestId = uuidv7();
    const { settled } = requestsState.apply({
      kind: 'create_candidate',
      requestId,
      input: {
        url: v.candidate.url,
        userId: user.user_id,
        youtubeId: v.candidate.externalId ?? null,
        title: v.candidate.title,
        whyText: v.candidate.whyText ?? null,
      },
    });
    await settled;
    markRequested.run(v.candidate.candidateId);
  }));

  // Verdicts are already in weighted-desc order. Build response payload
  // straight off the picks — no re-query, no recomputation. gemma_score
  // is connection × quality / 10 (0–10 range), kept in the response for
  // legacy callers that still display it; preserve null when either axis
  // is missing to match the DB column's nullable contract.
  const items = picks.map((v) => {
    const conn = v.candidate.connectionScore;
    const qual = v.candidate.qualityScore;
    return {
      title: v.candidate.title,
      score: conn === null || qual === null ? null : (conn * qual) / 10,
      why: v.candidate.whyText ?? null,
      guardVerdict: v.candidate.guardVerdict ?? null,
    };
  });

  return {
    userId: user.user_id,
    skipped: false,
    interestsChecked: userInterests.length,
    candidatesAdded: added,
    surfaced: picks.length,
    items,
  };
}

// `scored` rows live forever otherwise: they passed scoring but lost the
// daily ranker race, and there's no other path that touches them. Without
// this they accumulate monotonically — see issue #70 for the AI-channel
// backlog that motivated extending the original 'pending'-only prune.
export function pruneStalePool(): void {
  const result = db.prepare(`
    DELETE FROM candidate_pool
    WHERE status IN ('pending', 'scored')
      AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
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

export { scoreCandidates } from './scoring';
export { discoveryRouter } from './router';
