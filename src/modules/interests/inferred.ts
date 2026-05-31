import { db } from '../../db/client';
import { logger } from '../../logger';
import { guardQueue } from '../../queue';
import { SEARCH_TERMS_PENDING } from './reconcile';
import { KID_INTEREST_EVAL_JOB } from '../guard/index';

// Inferred interests (#156, ADR-0008). An inferred interest is NOT a stored
// row — it is a live view derived from the people the user follows:
//
//   followed_people → person_outputs (youtube) → channel_interest_links → interests
//
// deduped against the interests the user has already declared (a declared
// interest must not also appear as a proposal — no duplicate provenance) and
// minus any the user has Removed (a sparse suppression row, see migration 032).
// The set is inert: it feeds neither search nor scoring until a proposal is
// Kept, which promotes it to a declared user_interests row (keepInferredInterest).

export interface InferredInterest {
  interestId: string;
  label: string;
  category: string | null;
  // Signal strength, surfaced for the "Eddy noticed" band ordering. Distinct
  // followed people who link to this interest is the primary signal; max link
  // confidence across those channels is the tie-breaker.
  followerCount: number;
  confidence: number;
}

interface InferredRow {
  interest_id: string;
  label: string;
  category: string | null;
  follower_count: number;
  confidence: number;
}

// Live-derive the user's inferred interests, ordered by signal strength:
// distinct followed people first, then max channel-link confidence. Excludes
// interests the user has already declared and any they have Removed.
export function getInferredInterests(userId: string): InferredInterest[] {
  const rows = db.prepare(`
    SELECT i.id AS interest_id,
           i.label AS label,
           i.category AS category,
           COUNT(DISTINCT fp.person_id) AS follower_count,
           MAX(cil.confidence) AS confidence
    FROM followed_people fp
    INNER JOIN person_outputs po
      ON po.person_id = fp.person_id AND po.output_type = 'youtube'
    INNER JOIN channel_interest_links cil
      ON cil.channel_id = po.external_id
    INNER JOIN interests i
      ON i.id = cil.interest_id
    WHERE fp.user_id = ?
      AND i.id NOT IN (
        SELECT interest_id FROM user_interests WHERE user_id = ?
      )
      AND i.id NOT IN (
        SELECT interest_id FROM inferred_interest_suppressions WHERE user_id = ?
      )
      -- Kid-safety ordering (#52): an interest inferred from content (Tier 2)
      -- starts on the pending sentinel until its search_terms are generated.
      -- Don't propose it yet — a Keep enqueues the guard eval directly
      -- (keepInferredInterest), and the guard must see populated search_terms.
      -- Once generation lands (or reconcile re-runs it) the proposal appears;
      -- a permanently-failed generation stays hidden (fail-closed).
      AND i.search_terms != ?
    GROUP BY i.id, i.label, i.category
    ORDER BY follower_count DESC, confidence DESC, i.label ASC
  `).all(userId, userId, userId, SEARCH_TERMS_PENDING) as InferredRow[];

  return rows.map((r) => ({
    interestId: r.interest_id,
    label: r.label,
    category: r.category,
    followerCount: r.follower_count,
    confidence: r.confidence,
  }));
}

// Remove an inferred-interest proposal: write a sparse suppression row so it is
// never re-derived. This does NOT unfollow the person(s) — the follow stands
// and still yields that person's outputs as person-sourced candidates; only the
// broader topic proposal is suppressed (ADR-0008: a follow ≠ asking Eddy to
// search the whole subject).
export function suppressInferredInterest(userId: string, interestId: string): void {
  db.prepare(`
    INSERT INTO inferred_interest_suppressions (user_id, interest_id, suppressed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, interest_id) DO NOTHING
  `).run(userId, interestId, new Date().toISOString());
}

export interface KeptInterest {
  interestId: string;
  rank: number;
}

// Keep an inferred-interest proposal: the human act that promotes it to a
// declared interest (ADR-0008). Inserts a user_interests row at the next rank,
// mirroring normalizeUserAddedInterest's rank logic. The interest already
// exists in the shared vocabulary with populated search_terms, so there is no
// search-terms job to run.
//
// Kid safety (CLAUDE.md non-negotiable, #52): a Keep by a kid is a kid-authored
// interest add and MUST route through the kid-interest guard eval, exactly like
// the existing-interest branch of normalizeUserAddedInterest. The guard eval is
// enqueued AFTER the transaction commits so the declared row is visible to the
// eval, and a queue failure must NOT roll back the user's Keep. A Keep by a
// parent (non-kid) does not enqueue a guard eval.
export function keepInferredInterest(userId: string, interestId: string): KeptInterest {
  const role = (db.prepare('SELECT role FROM users WHERE user_id = ?')
    .get(userId) as { role: string } | undefined)?.role;
  const isKid = role === 'kid';

  const label = (db.prepare('SELECT label FROM interests WHERE id = ?')
    .get(interestId) as { label: string } | undefined)?.label ?? interestId;

  const now = new Date().toISOString();

  const rank = db.transaction(() => {
    const nextRank = (db.prepare(
      'SELECT COALESCE(MAX(rank), 0) + 1 AS r FROM user_interests WHERE user_id = ?'
    ).get(userId) as { r: number }).r;

    db.prepare(`
      INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
      VALUES (?, ?, ?, 'comfortable', 1, ?)
      ON CONFLICT(user_id, interest_id) DO NOTHING
    `).run(userId, interestId, nextRank, now);

    return nextRank;
  })();

  // Enqueue AFTER commit so the declared row is visible to the eval, and never
  // let a queue failure roll back the Keep — mirrors normalize.ts.
  if (isKid) {
    void guardQueue.add(KID_INTEREST_EVAL_JOB, {
      userId, interestId, rawLabel: label,
    }).catch((err: unknown) => {
      logger.warn({ err, interestId }, 'Kept inferred interest: failed to enqueue guard eval');
    });
  }

  return { interestId, rank };
}
