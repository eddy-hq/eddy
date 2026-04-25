import { db } from '../../db/client';
import { daysSince } from './util';
import { MIN_CONNECTION_SCORE, MIN_QUALITY_SCORE, MIN_WEIGHTED_SCORE, normalizeSensitivity } from './scoring';

// Decay applied at surfacing time, picked per content type:
//   news      — value drops fast (e.g. yesterday's match highlights)
//   standard  — most tutorials, fairly time-bound but not urgent
//   evergreen — technique fundamentals, philosophy, classic retrospectives
// A null/unknown sensitivity falls back to 'standard'.
export function freshnessMultiplier(
  publishedAt: string | null,
  sensitivity: string | null = 'standard',
): number {
  const days = daysSince(publishedAt);
  const kind = normalizeSensitivity(sensitivity);

  if (days === null) {
    if (kind === 'news') return 0.5;
    if (kind === 'evergreen') return 1.0;
    return 0.8;
  }

  if (kind === 'news') {
    if (days <= 1) return 1.6;
    if (days <= 2) return 1.2;
    if (days <= 7) return 0.6;
    if (days <= 30) return 0.2;
    if (days <= 90) return 0.1;
    return 0.05;
  }

  if (kind === 'evergreen') {
    if (days <= 1) return 1.4;
    if (days <= 7) return 1.2;
    if (days <= 30) return 1.1;
    if (days <= 365) return 1.0;
    return 0.9;
  }

  // standard
  if (days <= 1) return 1.6;
  if (days <= 2) return 1.4;
  if (days <= 7) return 1.2;
  if (days <= 30) return 1.0;
  if (days <= 90) return 0.7;
  return 0.4;
}

// Brief §9a: weight = 1/sqrt(rank). Lower-ranked interests are down-weighted,
// not eliminated, so the feed still leans on top interests but lets niche
// ones surface when their content is fresh and high quality.
export function rankWeight(rank: number): number {
  return 1 / Math.sqrt(Math.max(1, rank));
}

// Diversity rules: a daily feed of 15 picks should span many interests. A
// 2-per-interest cap with 12 interests yields ≥7 distinct interests in a
// full slate. Title-similarity dedup catches the "5 nearly identical
// running-form videos" case within a single interest.
const MAX_PER_INTEREST_ADULT = 2;
const MAX_PER_INTEREST_KID = 1;
const TITLE_SIMILARITY_THRESHOLD = 0.4;

const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'how', 'what',
  'why', 'this', 'that', 'these', 'those', 'just', 'will', 'from', 'into',
  'about', 'over', 'than', 'when', 'where', 'best',
]);

export function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface AllocatableItem {
  candidateId: string;
  title: string | null;
  interestId: string | null;
  rank: number;
  weighted: number;
}

export interface AllocateOptions {
  cap: number;
  isKid: boolean;
  prefilledTitles?: string[];
  prefilledInterestCounts?: Map<string, number>;
}

// Greedy slot allocation honouring per-interest cap, title-similarity
// dedup, and the rank>3 stretch reservation. Used by both surfaceForToday
// and the preview's simulation so they always agree on selection rules.
export function allocateSlots(
  ranked: AllocatableItem[],
  opts: AllocateOptions,
): Map<string, 'regular' | 'stretch'> {
  const { cap, isKid, prefilledTitles = [], prefilledInterestCounts = new Map() } = opts;
  const maxPerInterest = isKid ? MAX_PER_INTEREST_KID : MAX_PER_INTEREST_ADULT;
  const stretchQuota = Math.max(1, Math.floor(cap * 0.2));
  const regularQuota = cap - stretchQuota;

  const selected = new Map<string, 'regular' | 'stretch'>();
  const interestCounts = new Map<string, number>(prefilledInterestCounts);
  const selectedTokenSets: Set<string>[] = prefilledTitles.map(titleTokens);

  function tryPick(item: AllocatableItem, slot: 'regular' | 'stretch', honourInterestCap: boolean): boolean {
    if (selected.has(item.candidateId)) return false;

    if (honourInterestCap && item.interestId) {
      const count = interestCounts.get(item.interestId) ?? 0;
      if (count >= maxPerInterest) return false;
    }

    if (item.title) {
      const tokens = titleTokens(item.title);
      for (const existing of selectedTokenSets) {
        if (jaccardSimilarity(tokens, existing) >= TITLE_SIMILARITY_THRESHOLD) return false;
      }
      selectedTokenSets.push(tokens);
    }

    selected.set(item.candidateId, slot);
    if (item.interestId) {
      interestCounts.set(item.interestId, (interestCounts.get(item.interestId) ?? 0) + 1);
    }
    return true;
  }

  // Pass 1 — regular slots, top weighted, honour interest cap + similarity
  for (const item of ranked) {
    if (selected.size >= regularQuota) break;
    tryPick(item, 'regular', true);
  }

  // Pass 2 — stretch slots, items from interests outside top-3 only
  for (const item of ranked) {
    if (selected.size >= regularQuota + stretchQuota) break;
    if (item.rank <= 3) continue;
    tryPick(item, 'stretch', true);
  }

  // No Pass-3 cap-relaxing backfill: if diversity rules leave the feed
  // short, that's a valid outcome. Brief §9a: "Finishing 'Picked for you'
  // is a valid state — show 'That's it for today' rather than paginating."

  return selected;
}

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

export function surfaceForToday(userId: string, isKid: boolean): number {
  const today = new Date().toISOString().slice(0, 10);
  const cap = isKid ? 5 : 15;

  const alreadySurfaced = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).get(userId, today) as { n: number };
  if (alreadySurfaced.n >= cap) return 0;

  const remaining = cap - alreadySurfaced.n;
  const eligibleGuard = isKid ? "AND (c.guard_verdict = 'clear_yes' OR c.guard_verdict IS NULL)" : '';

  // History exclusion: anything we already have a record of — requested,
  // downloaded, deleted, or rejected — must never resurface via discovery.
  // The status filter handles candidates whose pool row has already
  // changed state; the NOT EXISTS clause covers requests sourced
  // independently (share-sheet, search) where the candidate_pool row
  // wasn't updated.
  const candidates = db.prepare(`
    SELECT c.candidate_id, c.title, c.published_at, c.connection_score,
           c.quality_score, c.time_sensitivity, c.interest_id,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    WHERE c.user_id = ? AND c.status = 'scored' ${eligibleGuard}
      AND c.surfaced_date IS NULL
      AND c.connection_score >= ${MIN_CONNECTION_SCORE}
      AND c.quality_score >= ${MIN_QUALITY_SCORE}
      AND NOT EXISTS (
        SELECT 1 FROM requests r
        WHERE r.user_id = c.user_id AND r.youtube_id = c.external_id
      )
  `).all(userId) as Array<{
    candidate_id: string;
    title: string | null;
    published_at: string | null;
    connection_score: number | null;
    quality_score: number | null;
    time_sensitivity: string | null;
    interest_id: string | null;
    rank: number;
  }>;

  if (candidates.length === 0) return 0;

  const ranked: AllocatableItem[] = candidates
    .map((c) => ({
      candidateId: c.candidate_id,
      title: c.title,
      interestId: c.interest_id,
      rank: c.rank,
      weighted: (c.connection_score ?? 0)
        * (c.quality_score ?? 0)
        * freshnessMultiplier(c.published_at, c.time_sensitivity)
        * rankWeight(c.rank),
    }))
    .filter((x) => x.weighted >= MIN_WEIGHTED_SCORE)
    .sort((a, b) => b.weighted - a.weighted);

  if (ranked.length === 0) return 0;

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

  const picked = allocateSlots(ranked, {
    cap: remaining,
    isKid,
    prefilledTitles,
    prefilledInterestCounts,
  });

  if (picked.size === 0) return 0;

  const now = new Date().toISOString();
  for (const candidateId of picked.keys()) {
    db.prepare(`
      UPDATE candidate_pool SET status = 'surfaced', surfaced_date = ?, surfaced_at = ?
      WHERE candidate_id = ?
    `).run(today, now, candidateId);
  }

  return picked.size;
}
