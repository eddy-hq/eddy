import { db } from '../../db/client';
import { rank, isPicked, bucketFor, type Bucket, type RankerCandidate, type Verdict } from './ranker';

export interface ScoredCandidateForGuard {
  candidate_id: string;
  title: string | null;
  url: string;
}

// Kid guard recheck candidates, the top `perBucketLimit` UN-rechecked scored
// rows in EACH composition bucket (ADR-0009).
//
// Two windowing hazards this guards against:
//   1. A flat top-N by gemma_score starves a kid's reserved back-catalogue /
//      delighter floors on a flood day: if the top N are all subscriptions,
//      the lower-raw-score candidates that would fill those floors stay
//      un-rechecked and (since kid surfacing requires clear_yes) can't surface
//      even when supply exists. Bucketing the recheck fixes that.
//   2. Already-guarded rows (guard_verdict NOT NULL — e.g. a previously
//      cleared-but-cut candidate) would otherwise consume the per-bucket
//      recheck window every run, starving newer NULL candidates that genuinely
//      need a pass. So the recheck targets only `guard_verdict IS NULL` rows —
//      the ones that have never been guarded. Cleared/rejected rows keep their
//      verdict and need no re-pass.
//
// Buckets here mirror ranker.bucketFor: subscription / person_backcatalog /
// everything-else (delighter). `perBucketLimit` is sized comfortably above the
// largest bucket quota so guard rejections don't exhaust the rechecked set
// before a floor is filled.
export function readScoredCandidatesByBucket(
  userId: string,
  perBucketLimit: number,
): ScoredCandidateForGuard[] {
  const row = db.prepare(`
    WITH ranked AS (
      SELECT candidate_id, title, url,
             ROW_NUMBER() OVER (
               PARTITION BY CASE
                 WHEN source_type = 'subscription' THEN 'subscription'
                 WHEN source_type = 'person_backcatalog' THEN 'person_backcatalog'
                 ELSE 'delighter'
               END
               ORDER BY gemma_score DESC
             ) AS rn
      FROM candidate_pool
      WHERE user_id = ? AND status = 'scored' AND guard_verdict IS NULL
    )
    SELECT candidate_id, title, url FROM ranked WHERE rn <= ?
  `);
  return row.all(userId, perBucketLimit) as ScoredCandidateForGuard[];
}

export function updateCandidatePoolStatus(
  candidateId: string,
  guardVerdict: string,
  status: string,
): void {
  db.prepare(`
    UPDATE candidate_pool SET guard_verdict = ?, status = ? WHERE candidate_id = ?
  `).run(guardVerdict, status, candidateId);
}

interface CandidateRow {
  candidate_id: string;
  url: string;
  external_id: string | null;
  title: string | null;
  published_at: string | null;
  connection_score: number | null;
  quality_score: number | null;
  time_sensitivity: string | null;
  source_type: string | null;
  interest_id: string | null;
  channel: string | null;
  rank: number;
  why_text: string | null;
  guard_verdict: string | null;
}

// Per-user slate size (ADR-0009). The numbers are role-blind — the only
// kid/adult difference is the guard recheck upstream — so the cap is read
// from the user's `daily_pick_cap`, falling back to the global default when
// the column is null. `isKid` still threads through purely for the kid guard
// filter on the candidate SELECT.
export function surfaceForToday(userId: string, isKid: boolean, cap: number): Verdict[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const alreadySurfaced = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).get(userId, today) as { n: number };
  if (alreadySurfaced.n >= cap) return [];

  // The ranker is handed the full per-user cap; the mid-day top-up is bounded
  // by prefilledBucketCounts (per-bucket spend already on today's slate)
  // rather than a scalar `remaining`, so each bucket tops up to its own quota.
  //
  // Kid surfacing requires an explicit `clear_yes` (ADR-0009 / kid-safety
  // non-negotiable). Now that follows route through the pool, a NULL
  // guard_verdict means the candidate was never guard-rechecked (e.g. it fell
  // outside the top-N recheck) — admitting it would surface a followed upload
  // to a kid unguarded, which is exactly the bypass this issue closes. Default
  // to escalation: an un-rechecked candidate does not surface for a kid.
  const eligibleGuard = isKid ? "AND c.guard_verdict = 'clear_yes'" : '';

  // Data-shape SQL only: status, surfaced_date, kid guard, history
  // exclusion, why_text presence. Score floors live in the ranker so
  // production and preview can't drift on what counts as eligible.
  //
  // why_text IS NOT NULL enforces brief §9a: every surfaced item must
  // carry a one-sentence explanation. If Gemma couldn't generate one,
  // the candidate doesn't surface.
  //
  // The requests NOT EXISTS excludes 'failed' rows so clear-parked
  // (ADR-0012) can free a parked auto-download for re-selection: it marks the
  // stuck row 'failed' and resets this candidate back to 'scored'. This is
  // safe against genuinely-failed downloads because those leave their
  // candidate_pool row at 'requested' (never re-set to 'scored'), so the
  // status='scored' filter above keeps them out regardless.
  const rows = db.prepare(`
    SELECT c.candidate_id, c.url, c.external_id, c.title, c.published_at,
           c.connection_score, c.quality_score, c.time_sensitivity,
           c.source_type, c.interest_id,
           c.channel, c.why_text, c.guard_verdict,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.status = 'scored' ${eligibleGuard}
      AND c.surfaced_date IS NULL
      AND c.why_text IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM requests r
        WHERE r.user_id = c.user_id AND r.youtube_id = c.external_id
          AND r.status != 'failed'
      )
  `).all(userId) as CandidateRow[];

  if (rows.length === 0) return [];

  const candidates: RankerCandidate[] = rows.map((r) => ({
    candidateId: r.candidate_id,
    title: r.title,
    publishedAt: r.published_at,
    connectionScore: r.connection_score,
    qualityScore: r.quality_score,
    timeSensitivity: r.time_sensitivity,
    sourceType: r.source_type,
    interestId: r.interest_id,
    channel: r.channel,
    rank: r.rank,
    whyText: r.why_text,
    guardVerdict: r.guard_verdict,
    url: r.url,
    externalId: r.external_id,
  }));

  // Carry over today's already-surfaced titles + interest counts + channel
  // counts + per-bucket counts so a mid-day re-run doesn't pile more from the
  // same interest, channel, or bucket, or echo a similar title.
  const surfacedToday = db.prepare(`
    SELECT title, source_type, interest_id, channel FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).all(userId, today) as Array<{
    title: string | null; source_type: string | null;
    interest_id: string | null; channel: string | null;
  }>;

  const prefilledTitles = surfacedToday.map((r) => r.title ?? '').filter((t) => t.length > 0);
  const prefilledInterestCounts = new Map<string, number>();
  const prefilledChannelCounts = new Map<string, number>();
  const prefilledBucketCounts = new Map<Bucket, number>();
  for (const r of surfacedToday) {
    const bucket = bucketFor(r.source_type);
    prefilledBucketCounts.set(bucket, (prefilledBucketCounts.get(bucket) ?? 0) + 1);
    // Subscriptions are exempt from the per-interest cap (ADR-0009), so don't
    // prefill an interest count from a subscription pick — that would let an
    // earlier subscription suppress a later back-catalogue/delighter on the
    // same inferred interest.
    if (bucket !== 'subscription' && r.interest_id) {
      prefilledInterestCounts.set(r.interest_id, (prefilledInterestCounts.get(r.interest_id) ?? 0) + 1);
    }
    if (r.channel) {
      prefilledChannelCounts.set(r.channel, (prefilledChannelCounts.get(r.channel) ?? 0) + 1);
    }
  }

  const verdicts = rank(
    candidates,
    { now, prefilledTitles, prefilledInterestCounts, prefilledChannelCounts, prefilledBucketCounts },
    { cap },
  );

  const nowIso = now.toISOString();
  const writeStmt = db.prepare(`
    UPDATE candidate_pool SET status = 'surfaced', surfaced_date = ?, surfaced_at = ?
    WHERE candidate_id = ?
  `);
  for (const v of verdicts) {
    if (isPicked(v.disposition)) {
      writeStmt.run(today, nowIso, v.candidate.candidateId);
    }
  }

  return verdicts;
}
