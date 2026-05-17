import { db } from '../../db/client';
import { rank, type RankerCandidate, type Verdict } from './ranker';

export interface ScoredCandidateForGuard {
  candidate_id: string;
  title: string | null;
  url: string;
}

export function readScoredCandidates(userId: string, limit: number): ScoredCandidateForGuard[] {
  return db.prepare(`
    SELECT candidate_id, title, url
    FROM candidate_pool
    WHERE user_id = ? AND status = 'scored'
    ORDER BY gemma_score DESC
    LIMIT ?
  `).all(userId, limit) as ScoredCandidateForGuard[];
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
  interest_id: string | null;
  rank: number;
  why_text: string | null;
  guard_verdict: string | null;
}

export function surfaceForToday(userId: string, isKid: boolean): Verdict[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const cap = isKid ? 5 : 15;

  const alreadySurfaced = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).get(userId, today) as { n: number };
  if (alreadySurfaced.n >= cap) return [];

  const remaining = cap - alreadySurfaced.n;
  const eligibleGuard = isKid ? "AND (c.guard_verdict = 'clear_yes' OR c.guard_verdict IS NULL)" : '';

  // Data-shape SQL only: status, surfaced_date, kid guard, history
  // exclusion, why_text presence. Score floors live in the ranker so
  // production and preview can't drift on what counts as eligible.
  //
  // why_text IS NOT NULL enforces brief §9a: every surfaced item must
  // carry a one-sentence explanation. If Gemma couldn't generate one,
  // the candidate doesn't surface.
  const rows = db.prepare(`
    SELECT c.candidate_id, c.url, c.external_id, c.title, c.published_at,
           c.connection_score, c.quality_score, c.time_sensitivity, c.interest_id,
           c.why_text, c.guard_verdict,
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
    interestId: r.interest_id,
    rank: r.rank,
    whyText: r.why_text,
    guardVerdict: r.guard_verdict,
    url: r.url,
    externalId: r.external_id,
  }));

  // Carry over today's already-surfaced titles + interest counts so a
  // mid-day re-run doesn't pile more from the same interest or echo a
  // similar title.
  const surfacedToday = db.prepare(`
    SELECT title, interest_id FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).all(userId, today) as Array<{ title: string | null; interest_id: string | null }>;

  const prefilledTitles = surfacedToday.map((r) => r.title ?? '').filter((t) => t.length > 0);
  const prefilledInterestCounts = new Map<string, number>();
  for (const r of surfacedToday) {
    if (!r.interest_id) continue;
    prefilledInterestCounts.set(r.interest_id, (prefilledInterestCounts.get(r.interest_id) ?? 0) + 1);
  }

  const verdicts = rank(
    candidates,
    { now, isKid, prefilledTitles, prefilledInterestCounts },
    { cap: remaining },
  );

  const nowIso = now.toISOString();
  const writeStmt = db.prepare(`
    UPDATE candidate_pool SET status = 'surfaced', surfaced_date = ?, surfaced_at = ?
    WHERE candidate_id = ?
  `);
  for (const v of verdicts) {
    if (v.disposition === 'regular' || v.disposition === 'stretch') {
      writeStmt.run(today, nowIso, v.candidate.candidateId);
    }
  }

  return verdicts;
}
