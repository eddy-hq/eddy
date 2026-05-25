import { Worker } from 'bullmq';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { redis, profileEnrichmentQueue } from '../../queue';
import { WATCHED_RATIO, WATCHED_TIME_FLOOR_S } from '../watch-events';
import { computeTrustWeight, TRUST_DEFAULT } from './util';
import { regenerateAffinities } from './affinities';
import { generateDriftObservations } from '../drift';
import { regenerateStaleWeekSummaries } from '../requests';

export { computeTrustWeight, TRUST_COLD_START_FLOOR, TRUST_DEFAULT, TRUST_BASELINE } from './util';
export {
  regenerateAffinities,
  readActiveAffinities,
  checkAffinityEligibility,
  AFFINITY_MIN_LIFETIME_EVENTS,
  buildAffinityDigest,
  buildAffinityPrompt,
  parseAffinityResponse,
  persistAffinities,
  filterValidEvidence,
} from './affinities';
export type {
  AffinityDigest,
  AffinityEligibility,
  RegenerateAffinitiesResult,
  ActiveAffinity,
  EvidenceRefType,
} from './affinities';

// ── Snapshot recompute ────────────────────────────────────────────────────────
//
// The snapshot is a per-(user, person) count of:
//   watched_count   — watch_events crossing the threshold (issue #56), grouped
//                     by the person who sourced the request (via
//                     requests.youtube_channel_id → person_outputs.external_id).
//   dismissed_count — union of:
//                       a) watch_events.reason='dismissed' (mid-play bailouts)
//                       b) candidate_pool.status='dismissed' (pre-play swipes)
//                       c) requests.status='deleted' (player-side delete —
//                          strong negative; surfaced for any source, not
//                          just discovery picks)
//                     deduplicated on (user_id, person_id, video_id) so a
//                     candidate dismissed pre-play and never replayed isn't
//                     counted twice when the same video later appears in
//                     watch_events.
//
// The aggregation lives in SQL because better-sqlite3 is synchronous and the
// alternative (streaming every event through JS) burns memory on the M4.
// Snapshot is recomputed in place — old rows for the user are deleted before
// the fresh insert so the table never drifts from the events stream.

interface AggregateRow {
  person_id: string;
  watched_count: number;
  dismissed_count: number;
}

const AGGREGATE_SQL = `
  WITH user_watch_events AS (
    SELECT we.event_id, we.video_id, we.reason, we.position_s, we.duration_s,
           po.person_id
    FROM watch_events we
    INNER JOIN requests r ON r.request_id = we.request_id
    INNER JOIN person_outputs po
      ON po.external_id = r.youtube_channel_id
     AND po.output_type = 'youtube'
    WHERE we.user_id = @user_id
      AND r.youtube_channel_id IS NOT NULL
  ),
  watched AS (
    SELECT person_id, COUNT(*) AS n
    FROM user_watch_events
    WHERE reason = 'ended'
       OR (duration_s > 0 AND CAST(position_s AS REAL) / duration_s >= @watched_ratio)
       OR position_s >= @watched_floor
    GROUP BY person_id
  ),
  dismissed_keys AS (
    -- Mid-play bailouts: watch_events.reason='dismissed'
    SELECT DISTINCT person_id, video_id
    FROM user_watch_events
    WHERE reason = 'dismissed'
    UNION
    -- Pre-play swipe-dismisses: candidate_pool.status='dismissed'
    SELECT DISTINCT person_id, external_id AS video_id
    FROM candidate_pool
    WHERE user_id = @user_id
      AND status = 'dismissed'
      AND person_id IS NOT NULL
      AND external_id IS NOT NULL
    UNION
    -- Player-side deletes: requests.status='deleted'. Source-agnostic
    -- (share-sheet, follow, pick all count) — the act of deleting after
    -- arrival is the signal, regardless of how the video got into the feed.
    SELECT DISTINCT po.person_id, r.youtube_id AS video_id
    FROM requests r
    INNER JOIN person_outputs po
      ON po.external_id = r.youtube_channel_id
     AND po.output_type = 'youtube'
    WHERE r.user_id = @user_id
      AND r.status = 'deleted'
      AND r.youtube_channel_id IS NOT NULL
      AND r.youtube_id IS NOT NULL
  ),
  dismissed AS (
    SELECT person_id, COUNT(*) AS n
    FROM dismissed_keys
    GROUP BY person_id
  )
  SELECT
    COALESCE(w.person_id, d.person_id) AS person_id,
    COALESCE(w.n, 0) AS watched_count,
    COALESCE(d.n, 0) AS dismissed_count
  FROM watched w
  FULL OUTER JOIN dismissed d ON d.person_id = w.person_id
  WHERE COALESCE(w.person_id, d.person_id) IS NOT NULL
`;

export function recomputeBehaviouralSnapshot(userId: string): number {
  const now = new Date().toISOString();
  const rows = db.prepare(AGGREGATE_SQL).all({
    user_id: userId,
    watched_ratio: WATCHED_RATIO,
    watched_floor: WATCHED_TIME_FLOOR_S,
  }) as AggregateRow[];

  const tx = db.transaction((items: AggregateRow[]) => {
    db.prepare('DELETE FROM behavioural_signals WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT INTO behavioural_signals
        (user_id, person_id, watched_count, dismissed_count, recomputed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const r of items) {
      insert.run(userId, r.person_id, r.watched_count, r.dismissed_count, now);
    }
  });
  tx(rows);

  return rows.length;
}

// ── Trust weights ─────────────────────────────────────────────────────────────
//
// Reads the latest snapshot and writes trust_weight back onto followed_people.
// Persons the user follows but has no engagement signal for stay at the
// default (TRUST_DEFAULT = 1.0). Persons in the snapshot below the cold-start
// floor (computeTrustWeight handles the gate) also stay at default.

interface SnapshotRow {
  person_id: string;
  watched_count: number;
  dismissed_count: number;
}

export function recomputeTrustWeights(userId: string): number {
  const rows = db.prepare(`
    SELECT person_id, watched_count, dismissed_count
    FROM behavioural_signals
    WHERE user_id = ?
  `).all(userId) as SnapshotRow[];

  // Reset every followed person to default first so a person who was once
  // high-trust but is no longer in the snapshot (e.g. all their videos
  // request-deleted) doesn't keep a stale weight. The UPDATE below then
  // re-applies fresh values for persons with signal.
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE followed_people SET trust_weight = ? WHERE user_id = ?'
    ).run(TRUST_DEFAULT, userId);

    const update = db.prepare(
      'UPDATE followed_people SET trust_weight = ? WHERE user_id = ? AND person_id = ?'
    );
    let applied = 0;
    for (const r of rows) {
      const weight = computeTrustWeight(r.watched_count, r.dismissed_count);
      const result = update.run(weight, userId, r.person_id);
      if (result.changes > 0) applied += 1;
    }
    return applied;
  });
  return tx();
}

// ── Job runner ────────────────────────────────────────────────────────────────

interface UserRow {
  user_id: string;
}

async function runProfileEnrichment(): Promise<void> {
  logger.info('Profile enrichment job started');

  const users = db.prepare(
    "SELECT user_id FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  for (const user of users) {
    try {
      const personsInSnapshot = recomputeBehaviouralSnapshot(user.user_id);
      const trustApplied = recomputeTrustWeights(user.user_id);
      logger.info(
        { userId: user.user_id, personsInSnapshot, trustApplied },
        'Profile enrichment: user recompute complete'
      );
    } catch (err) {
      logger.error({ err, userId: user.user_id }, 'Profile enrichment: user run failed');
    }
  }

  logger.info('Profile enrichment job complete');
}

// Weekly affinities run. Daily cadence is too aggressive for a Gemma round
// trip per user; Sunday evening keeps the model load off the family's prime
// viewing window and gives the week's behavioural_signals time to settle.
async function runAffinityRegeneration(): Promise<void> {
  logger.info('Affinity regeneration job started');

  const users = db.prepare(
    "SELECT user_id FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  for (const user of users) {
    try {
      const result = await regenerateAffinities(user.user_id);
      if (result.skipped) {
        logger.info(
          { userId: user.user_id, reason: result.skipReason },
          'Affinity regeneration: user skipped'
        );
      } else {
        logger.info(
          {
            userId: user.user_id,
            statementCount: result.statementCount,
            evidenceCount: result.evidenceCount,
            supersededCount: result.supersededCount,
          },
          'Affinity regeneration: user complete'
        );
      }
    } catch (err) {
      logger.error({ err, userId: user.user_id }, 'Affinity regeneration: user run failed');
    }

    // Drift observations ride the same weekly cadence: depth observations read
    // whatever affinities are active, and disagreement is a deterministic
    // weekly behavioural read. Run in its own try so a thrown affinity pass
    // above (Gemma error) doesn't suppress the deterministic disagreement
    // observation for the user. The depth observation simply reads the prior
    // active affinities if regeneration failed this week.
    try {
      const drift = generateDriftObservations(user.user_id);
      logger.info(
        { userId: user.user_id, observationCount: drift.observationCount },
        'Drift observations: user complete'
      );
    } catch (err) {
      logger.error({ err, userId: user.user_id }, 'Drift observations: user run failed');
    }
  }

  logger.info('Affinity regeneration job complete');
}

// Weekly (Sunday 21:00): regenerate stale Tier 4 week summaries. "Stale" means a
// week with no cached row — which a week becomes the moment it crosses the
// 30-day line into Tier 4 — or one whose item count has drifted. Cached weeks
// with an unchanged count are skipped, so in steady state this is about one
// Gemma call per user per week. The requests module owns the generation, prompt
// and guards (the same path the admin endpoint drives); we only trigger it on
// this cadence so summaries appear without a manual admin call.
async function runWeekSummaries(): Promise<void> {
  logger.info('Week summaries job started');

  const users = db.prepare(
    "SELECT user_id FROM users WHERE role IN ('kid', 'parent')"
  ).all() as UserRow[];

  for (const user of users) {
    try {
      const result = await regenerateStaleWeekSummaries(user.user_id);
      logger.info(
        {
          userId: user.user_id,
          selected: result.staleCount,
          generated: result.generated,
          nulled: result.nulled,
        },
        'Week summaries: user complete'
      );
    } catch (err) {
      logger.error({ err, userId: user.user_id }, 'Week summaries: user run failed');
    }
  }

  logger.info('Week summaries job complete');
}

let profileEnrichmentWorker: Worker | null = null;

// Daily run at 05:00 — strictly before discovery (06:00) so the nightly
// trust recompute is reflected in the same morning's scoring. Weekly
// affinity run kicks off Sunday 21:00 local; cron uses server time which
// matches family time on the M4. Same registration pattern as discovery
// (src/modules/discovery/index.ts).
export function startProfileEnrichmentScheduler(): void {
  void profileEnrichmentQueue.add('run', {}, {
    repeat: { pattern: '0 5 * * *' },
    jobId: 'profile-enrichment-daily',
  }).catch((err: unknown) =>
    logger.warn({ err }, 'Profile enrichment: failed to schedule repeatable job')
  );

  void profileEnrichmentQueue.add('affinities', {}, {
    repeat: { pattern: '0 21 * * 0' },
    jobId: 'profile-enrichment-affinities-weekly',
  }).catch((err: unknown) =>
    logger.warn({ err }, 'Affinity regeneration: failed to schedule repeatable job')
  );

  void profileEnrichmentQueue.add('week-summaries', {}, {
    repeat: { pattern: '0 21 * * 0' },
    jobId: 'week-summaries-weekly',
  }).catch((err: unknown) =>
    logger.warn({ err }, 'Week summaries: failed to schedule repeatable job')
  );

  profileEnrichmentWorker = new Worker('profile-enrichment', async (job) => {
    if (job.name === 'run') await runProfileEnrichment();
    else if (job.name === 'affinities') await runAffinityRegeneration();
    else if (job.name === 'week-summaries') await runWeekSummaries();
  }, { connection: redis, concurrency: 1 });

  profileEnrichmentWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Profile enrichment job completed');
  });
  profileEnrichmentWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Profile enrichment job failed');
  });

  logger.info('Profile enrichment scheduler started (daily 05:00, affinities + week summaries Sunday 21:00)');
}

export async function stopProfileEnrichmentScheduler(): Promise<void> {
  if (profileEnrichmentWorker) {
    await profileEnrichmentWorker.close();
    profileEnrichmentWorker = null;
  }
}
