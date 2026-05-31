import { Worker } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { redis, discoveryQueue } from '../../queue';
import { evaluateCandidate } from '../guard/index';
import { getRequestsState } from '../requests';
import { runRssPollPass } from '../people';
import { getAgeBand } from '../users';
import {
  refreshCandidatePool,
  seedBackCatalogCandidates,
  type UserInterestRow,
} from './intake';
import { scoreCandidates } from './scoring';
import { bucketFor, isPicked } from './ranker';
import { sleep } from './util';
import {
  surfaceForToday,
  readScoredCandidatesByBucket,
  updateCandidatePoolStatus,
} from './surface';

interface UserRow {
  user_id: string;
  role: string;
  age_gate: number;
  // Per-user slate size (ADR-0009). Null falls back to
  // config.DEFAULT_DAILY_PICK_CAP.
  daily_pick_cap: number | null;
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

// Per-bucket recheck depth for the kid guard (ADR-0009). The recheck runs over
// the top-N scored rows in EACH composition bucket, not the top-N overall — a
// flat top-N starves a kid's reserved back-catalogue / delighter floors on a
// subscription flood day (those candidates stay un-rechecked, and kid
// surfacing requires clear_yes). 12 sits comfortably above the largest bucket
// quota (subscription = cap − 6 with the default cap of 15 → 9) so guard
// rejections don't exhaust the rechecked set before a floor fills.
const KID_GUARD_RECHECK_PER_BUCKET = 12;

// The connection-axis vocabulary that feeds scoring. Per ADR-0008, this is
// built from DECLARED interests only — stored `user_interests` rows. Inferred
// interests (live-derived from follows, see interests/inferred.ts) are inert
// proposals and MUST NOT reach scoring until the user Keeps one, at which point
// it is already a declared `user_interests` row here. This selection is the
// boundary the regression tests pin: it reads `user_interests` and nothing
// from the inference path.
export function selectDeclaredInterests(userId: string): UserInterestRow[] {
  return db.prepare(`
    SELECT ut.interest_id, t.label, ut.rank, ut.expertise, t.search_terms
    FROM user_interests ut
    INNER JOIN interests t ON t.id = ut.interest_id
    WHERE ut.user_id = ?
    ORDER BY ut.rank ASC
  `).all(userId) as UserInterestRow[];
}

export async function runDiscoveryForUser(user: UserRow, options: { force?: boolean } = {}): Promise<DiscoveryRunResult> {
  const today = new Date().toISOString().slice(0, 10);
  const isKid = user.role === 'kid';
  // Role-blind slate size (ADR-0009): per-user cap, falling back to the global
  // default. The only kid/adult difference is the guard recheck below.
  const cap = user.daily_pick_cap ?? config.DEFAULT_DAILY_PICK_CAP;

  const existing = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool WHERE user_id = ? AND surfaced_date = ?
  `).get(user.user_id, today) as { n: number };

  if (existing.n >= cap && !options.force) {
    logger.info({ userId: user.user_id }, 'Discovery: already at cap for today, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'Already at daily cap (use --force to override)', interestsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  const userInterests = selectDeclaredInterests(user.user_id);

  // A user with no declared interests can still have follows, and follows now
  // route through the scored pool (ADR-0009) — so only skip when there is
  // genuinely nothing to source: no interests AND no follows. A follow-only
  // user proceeds; interest search just contributes nothing to the delighter
  // bucket, and subscription + back-catalogue candidates still flow.
  const followCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM followed_people WHERE user_id = ?',
  ).get(user.user_id) as { n: number }).n;

  if (userInterests.length === 0 && followCount === 0) {
    logger.info({ userId: user.user_id }, 'Discovery: user has no interests and no follows, skipping');
    return { userId: user.user_id, skipped: true, skipReason: 'No interests or follows set', interestsChecked: 0, candidatesAdded: 0, surfaced: 0, items: [] };
  }

  // One scored pool composed into reserved slots (ADR-0009). The RSS poll runs
  // once at the job level (runDiscovery), before the per-user loop and before
  // any skip — see the spec/reality fix there. By the time this per-user
  // composition runs, this run's subscription candidates are already in the
  // pool. Order here: seed back catalogue → interest search. The back-catalogue
  // seeder dedups via isDuplicateCandidate (pool + requests), not seen_videos,
  // so the poll-first ordering doesn't starve it of a new follow's recent
  // uploads.
  logger.info({ userId: user.user_id, interests: userInterests.length }, 'Discovery: refreshing candidate pool');

  // Back-catalogue seeder mines the rest of each followed channel.
  const backCatalogAdded = await seedBackCatalogCandidates(user.user_id);
  logger.info({ userId: user.user_id, added: backCatalogAdded }, 'Discovery: back-catalog candidates added');

  // Interest search runs unconditionally at full budget to supply the
  // delighter bucket — the #149 gate (skip discovery when person supply is
  // sufficient) is gone (ADR-0009).
  const interestSearchAdded = await refreshCandidatePool(user.user_id, userInterests);
  logger.info({ userId: user.user_id, added: interestSearchAdded }, 'Discovery: interest-search candidates added');

  const added = interestSearchAdded + backCatalogAdded;

  await scoreCandidates(user.user_id, userInterests);

  if (isKid) {
    const ageBand = getAgeBand(user.user_id);
    // Scale the per-bucket recheck depth with the cap so a large per-user cap
    // (subscription quota = cap − 6) can't outrun the rechecked set.
    const perBucket = Math.max(KID_GUARD_RECHECK_PER_BUCKET, cap);
    const scored = readScoredCandidatesByBucket(user.user_id, perBucket);
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

  const verdicts = surfaceForToday(user.user_id, isKid, cap);
  const picks = verdicts.filter((v) => isPicked(v.disposition));
  logger.info({ userId: user.user_id, surfaced: picks.length }, 'Discovery: surfaced for today');

  // Picks land in the feed directly — no separate accept step. Create a
  // request via the state machine (inserts a row with status=downloading +
  // why_text and enqueues the download), then flip the candidate_pool row to
  // 'requested' so the day-cap accounting holds. Request provenance is mapped
  // from the candidate's source_type (ADR-0009): subscription / back-catalogue
  // → 'channel_subscription' (follow pill); delighter → 'recommended' (pick
  // pill).
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
    const requestSource = bucketFor(v.candidate.sourceType) === 'delighter'
      ? 'recommended'
      : 'channel_subscription';
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
        source: requestSource,
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

  // RSS poll is the job's first awaited step (ADR-0009) — once, channel-wide,
  // before the per-user loop and before any per-user skip. The poll advances
  // `seen_videos` and seeds subscription candidates regardless of whether any
  // individual user is later skipped (already-at-cap / no interests), so a
  // skipped user can't cause RSS uploads to backlog. The retired setInterval
  // poller's daily cadence now rides on the discovery schedule.
  await runRssPollPass().catch((err: unknown) => {
    logger.error({ err }, 'Discovery: RSS poll pass failed');
  });

  const users = db.prepare(
    "SELECT user_id, role, age_gate, daily_pick_cap FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  // Stagger per-user runs (#185). The daily job fires for the whole fleet at
  // 06:00; running users back-to-back concentrates every user's yt-dlp search
  // fan-out and download flood into one window from one residential IP. A gap
  // between users spreads that load. The RSS poll above already ran once,
  // channel-wide, so the only thing being spaced here is per-user work.
  const staggerMs = config.DISCOVERY_USER_STAGGER_MS;
  for (let i = 0; i < users.length; i++) {
    const user = users[i]!;
    if (i > 0) await sleep(staggerMs);
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
