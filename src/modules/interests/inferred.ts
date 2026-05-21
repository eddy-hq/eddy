import { db } from '../../db/client';
import { logger } from '../../logger';

// Inferred interests (ADR-0008): a live view derived from a user's follows,
// never stored. The join is
//   followed_people → person_outputs (youtube, active) → channel_interest_links → interests
// deduped against the user's already-declared interests and minus any the user
// has Removed (a sparse suppression row). These are inert *proposals* until
// Kept — keeping promotes the row into the declared user_interests table, which
// is the human act that licenses interest search and scoring vocabulary. Until
// then nothing here feeds discovery.

export interface InferredInterest {
  interestId: string;
  label: string;
  category: string | null;
  // Signal strength, surfaced for the "Eddy noticed" band (slice #4) and used
  // as the ordering key here: how many distinct followed people map to this
  // interest, and the strongest channel→interest confidence behind it.
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

// Returns interests linked to the channels of the people the user follows,
// excluding any the user has already declared (no duplicate provenance) and
// any the user has Removed (suppressed). Ordered by signal strength: distinct
// followed people first, then strongest channel→interest confidence.
export function getInferredInterests(userId: string): InferredInterest[] {
  const rows = db.prepare(`
    SELECT
      cil.interest_id                       AS interest_id,
      i.label                               AS label,
      i.category                            AS category,
      COUNT(DISTINCT fp.person_id)          AS follower_count,
      MAX(cil.confidence)                   AS confidence
    FROM followed_people fp
    INNER JOIN person_outputs po
      ON po.person_id = fp.person_id
     AND po.output_type = 'youtube'
     AND po.active = 1
    INNER JOIN channel_interest_links cil
      ON cil.channel_id = po.external_id
    INNER JOIN interests i
      ON i.id = cil.interest_id
    WHERE fp.user_id = ?
      AND cil.interest_id NOT IN (
        SELECT interest_id FROM user_interests WHERE user_id = ?
      )
      AND cil.interest_id NOT IN (
        SELECT interest_id FROM inferred_interest_suppressions WHERE user_id = ?
      )
    GROUP BY cil.interest_id, i.label, i.category
    ORDER BY follower_count DESC, confidence DESC, i.label ASC
  `).all(userId, userId, userId) as InferredRow[];

  return rows.map((r) => ({
    interestId: r.interest_id,
    label: r.label,
    category: r.category,
    followerCount: r.follower_count,
    confidence: r.confidence,
  }));
}

// Remove: persist a suppression so re-deriving never resurfaces this interest.
// Sparse — only the suppressed pair is stored. Crucially this does NOT unfollow
// the person; the follow still yields that person's outputs as Candidates
// (ADR-0008). Idempotent.
export function suppressInferredInterest(userId: string, interestId: string): void {
  db.prepare(`
    INSERT INTO inferred_interest_suppressions (user_id, interest_id, suppressed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, interest_id) DO NOTHING
  `).run(userId, interestId, new Date().toISOString());
  logger.info({ userId, interestId }, 'Inferred interest suppressed');
}

// Keep: the human act that promotes an inferred proposal to a declared
// interest. Inserts a user_interests row at the next rank, mirroring the
// rank logic in normalizeUserAddedInterest (normalize.ts). Inference only
// proposes interests already in the shared vocabulary (ADR-0008 Tier 2 is
// deferred), so the interests row is guaranteed to exist — no creation here.
// If a suppression exists for this pair we clear it, so a Keep after a Remove
// reflects the latest human act. Idempotent on the user_interests insert.
export function keepInferredInterest(userId: string, interestId: string): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    const nextRank = (db.prepare(
      'SELECT COALESCE(MAX(rank), 0) + 1 AS r FROM user_interests WHERE user_id = ?'
    ).get(userId) as { r: number }).r;

    db.prepare(`
      INSERT INTO user_interests (user_id, interest_id, rank, expertise, liked, added_at)
      VALUES (?, ?, ?, 'comfortable', 1, ?)
      ON CONFLICT(user_id, interest_id) DO NOTHING
    `).run(userId, interestId, nextRank, now);

    db.prepare(
      'DELETE FROM inferred_interest_suppressions WHERE user_id = ? AND interest_id = ?'
    ).run(userId, interestId);
  })();
  logger.info({ userId, interestId }, 'Inferred interest kept (promoted to declared)');
}
