import { Worker } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { redis, discoveryQueue } from '../../queue';
import { evaluateCandidate, ensureVideoMetadata } from '../guard/index';
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
import { buildDiscoverySchedule, cronAt, utcDayStartIso, planAutomatedDownloads, automatedDownloadAllowance } from './util';
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

// Count every download that entered today (UTC), across all users. The global
// daily budget (ADR-0012) is a running cross-run tally, not a per-run number:
// per-user slate jobs fire at their own hours through the day, so each run must
// read the shared spend so far rather than assume a fresh allowance. Every
// requests row is a download (all three creators insert status='downloading'),
// so a plain COUNT over today's `requested_at` captures the lot — including the
// explicit share-sheet / on-demand requests that count toward the tally but are
// never themselves refused (they don't route through the budget gate below).
export function countDownloadsToday(now: Date = new Date()): number {
  const dayStart = utcDayStartIso(now);
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM requests WHERE requested_at >= ?',
  ).get(dayStart) as { n: number };
  return row.n;
}

// As countDownloadsToday, but scoped to one user — the spend against that user's
// per-user daily cap (ADR-0012, 2026-07-23 amendment). Same "every requests row
// is a download" reasoning, so a user's share-sheet / on-demand fetches count
// toward their own cap too (they are still never refused by the gate below).
export function countDownloadsTodayForUser(userId: string, now: Date = new Date()): number {
  const dayStart = utcDayStartIso(now);
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM requests WHERE user_id = ? AND requested_at >= ?',
  ).get(userId, dayStart) as { n: number };
  return row.n;
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
  // once per day in its own `rss-poll` job at the earliest user's hour, before
  // any per-user job — so by the time this composition runs, today's
  // subscription candidates are already in the pool. Order here: seed back
  // catalogue → interest search. The back-catalogue
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
    // Richer guard inputs (Phase 6a): fetch Data API metadata for any
    // candidate without a stored row. Never throws — a failure leaves those
    // candidates on title + channel alone.
    const metadata = await ensureVideoMetadata(
      scored.map((c) => c.external_id).filter((id): id is string => !!id),
    );
    for (const c of scored) {
      const meta = c.external_id ? metadata.get(c.external_id) : undefined;
      const verdict = await evaluateCandidate({
        candidateId: c.candidate_id,
        userId: user.user_id,
        url: c.url,
        title: c.title ?? '',
        channel: c.channel,
        ageBand,
        description: meta?.description ?? null,
        tags: meta?.tags ?? null,
        categoryId: meta?.categoryId ?? null,
        madeForKids: meta?.madeForKids ?? null,
        ageRestricted: meta?.ageRestricted ?? false,
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

  // Global daily download budget (ADR-0012). Automated downloads (slate-selected
  // delighters + follow-sourced subscription / back-catalogue picks) share one
  // budget per UTC day across the whole fleet; slate-bound picks are funded
  // first, follows second. Once the budget is spent, the remaining picks are
  // deferred — reverted to 'scored' so a later slate can re-select them (no
  // failure state). Explicit share-sheet / on-demand requests never pass through
  // here, so they are never refused, though they do consume the same tally.
  const spentToday = countDownloadsToday();
  const spentTodayUser = countDownloadsTodayForUser(user.user_id);
  const remaining = automatedDownloadAllowance(
    config.DOWNLOAD_DAILY_BUDGET,
    spentToday,
    config.PER_USER_DOWNLOAD_DAILY_BUDGET,
    spentTodayUser,
  );
  const plan = planAutomatedDownloads(
    picks,
    (v) => bucketFor(v.candidate.sourceType) === 'delighter',
    remaining,
  );

  if (plan.toDefer.length > 0) {
    // surfaceForToday already flipped these scored→surfaced with today's
    // surfaced_date; revert so they neither block re-selection (surface requires
    // status='scored' AND surfaced_date IS NULL) nor linger in today's feed
    // without a download. They re-compete in a future slate under fresh budget.
    const revertSurfaced = db.prepare(
      `UPDATE candidate_pool
         SET status = 'scored', surfaced_date = NULL, surfaced_at = NULL
       WHERE candidate_id = ?`,
    );
    for (const v of plan.toDefer) revertSurfaced.run(v.candidate.candidateId);
    logger.info(
      {
        userId: user.user_id,
        globalBudget: config.DOWNLOAD_DAILY_BUDGET,
        spentToday,
        perUserBudget: config.PER_USER_DOWNLOAD_DAILY_BUDGET,
        spentTodayUser,
        deferred: plan.toDefer.length,
        downloading: plan.toDownload.length,
      },
      'Discovery: download budget spent — deferring automated candidates to a later day',
    );
  }

  await Promise.all(plan.toDownload.map(async (v) => {
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

  // Build response payload off the picks that actually landed a download —
  // budget-deferred picks were reverted to 'scored' above and did not surface.
  // gemma_score is connection × quality / 10 (0–10 range), kept in the response
  // for legacy callers that still display it; preserve null when either axis is
  // missing to match the DB column's nullable contract.
  const items = plan.toDownload.map((v) => {
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
    surfaced: plan.toDownload.length,
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

// Per-user discovery jobs (#185) fire at each user's own hour so the fleet's
// yt-dlp search + download volume spreads across the day. The channel-wide RSS
// poll is a separate daily job at the earliest user's hour; users run a few
// minutes past the hour so the poll is picked up first (concurrency 1 serialises
// the rest if the poll runs long).
const RSS_POLL_JOB_ID = 'discovery-rss-poll';
const USER_CRON_MINUTE = 10;

// Run discovery for one scheduled user. Re-reads the row at fire time (the
// schedule is fixed at startup, but roles/caps can change since) and skips
// cleanly if the user is gone or no longer eligible.
async function runScheduledUser(userId: string): Promise<void> {
  const user = db.prepare(
    "SELECT user_id, role, age_gate, daily_pick_cap FROM users WHERE user_id = ? AND role IN ('kid', 'parent')"
  ).get(userId) as UserRow | undefined;
  if (!user) {
    logger.warn({ userId }, 'Discovery: scheduled user missing or ineligible, skipping');
    return;
  }
  await runDiscoveryForUser(user).catch((err: unknown) => {
    logger.error({ err, userId }, 'Discovery: user run failed');
  });
}

// Reconcile repeatable jobs to the desired set on every startup: drop all
// existing repeatables (clears the retired single 'discovery-daily' job and any
// stale hour) then add one RSS-poll job plus one job per eligible user at its
// configured hour. Idempotent — safe to run on each boot.
async function reconcileDiscoverySchedule(): Promise<void> {
  for (const job of await discoveryQueue.getRepeatableJobs()) {
    await discoveryQueue.removeRepeatableByKey(job.key);
  }

  const userIds = (db.prepare(
    "SELECT user_id FROM users WHERE role IN ('kid', 'parent')"
  ).all() as { user_id: string }[]).map((u) => u.user_id);

  const hourByUser: Record<string, number> = {};
  for (const entry of config.discoverySchedule) hourByUser[entry.userId] = entry.hour;

  const { pollHour, users } = buildDiscoverySchedule(
    userIds,
    hourByUser,
    config.DISCOVERY_HOUR_DEFAULT,
  );

  await discoveryQueue.add('rss-poll', {}, {
    repeat: { pattern: cronAt(pollHour, 0) },
    jobId: RSS_POLL_JOB_ID,
  });
  for (const user of users) {
    await discoveryQueue.add('user', { userId: user.userId }, {
      repeat: { pattern: cronAt(user.hour, USER_CRON_MINUTE) },
      jobId: `discovery-user-${user.userId}`,
    });
  }

  logger.info({ pollHour, users }, 'Discovery schedule reconciled');
}

let discoveryWorker: Worker | null = null;

export function startDiscoveryScheduler(): void {
  void reconcileDiscoverySchedule().catch((err: unknown) =>
    logger.warn({ err }, 'Discovery: failed to reconcile schedule'));

  discoveryWorker = new Worker('discovery', async (job) => {
    if (job.name === 'rss-poll') {
      // Channel-wide, once daily, ahead of any user (ADR-0009). Advances
      // seen_videos and seeds subscription candidates regardless of per-user
      // skips, so a skipped user can't backlog RSS uploads. Stale-pool prune
      // rides here too — once a day, off the per-user path.
      await runRssPollPass().catch((err: unknown) => {
        logger.error({ err }, 'Discovery: RSS poll pass failed');
      });
      pruneStalePool();
    } else if (job.name === 'user') {
      const userId = (job.data as { userId?: unknown }).userId;
      if (typeof userId === 'string') {
        await runScheduledUser(userId);
      } else {
        logger.warn({ jobId: job.id }, 'Discovery: user job missing userId');
      }
    }
  }, { connection: redis, concurrency: 1 });

  discoveryWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Discovery job completed');
  });
  discoveryWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id, name: job?.name }, 'Discovery job failed');
  });

  logger.info('Discovery scheduler started (per-user hours, #185)');
}

export async function stopDiscoveryScheduler(): Promise<void> {
  if (discoveryWorker) {
    await discoveryWorker.close();
    discoveryWorker = null;
  }
}

export { scoreCandidates } from './scoring';
export { discoveryRouter } from './router';
