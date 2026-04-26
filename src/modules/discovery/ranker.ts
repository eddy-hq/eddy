// Pure ranker: classifies and allocates scored candidates into a daily
// feed. Both production (surface.ts) and preview pipe their candidates
// through `rank()` so the two paths can never disagree about what would
// surface for a given input. No DB, no clock, no logger — `now: Date`
// flows in via context.
//
// Brief §9a: "If Gemma can't explain why, the item doesn't surface" — the
// floors below are the implementation of that constraint, plus a guard
// against the per-interest cap forcing in weak picks just because nothing
// better exists for that interest.

// Hard floors. Items below either single-axis floor never enter slot
// competition; the weighted floor catches the case where a high-axis
// score is wiped out by old freshness or low rank weight (e.g. a 2-year-
// old "news" item still scoring conn 9 / qual 6 → weighted ≈ 2.7).
export const MIN_CONNECTION_SCORE = 6;
export const MIN_QUALITY_SCORE = 5;
export const MIN_WEIGHTED_SCORE = 5;

// Diversity rules: a daily feed of 15 picks should span many interests.
// 2-per-interest with 12 interests yields ≥7 distinct interests in a full
// slate; the kid feed is tighter at 1-per-interest.
const MAX_PER_INTEREST_ADULT = 2;
const MAX_PER_INTEREST_KID = 1;
const TITLE_SIMILARITY_THRESHOLD = 0.4;

const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'how', 'what',
  'why', 'this', 'that', 'these', 'those', 'just', 'will', 'from', 'into',
  'about', 'over', 'than', 'when', 'where', 'best',
]);

export type TimeSensitivity = 'news' | 'standard' | 'evergreen';

export type Disposition =
  | 'regular'
  | 'stretch'
  | 'low_conn'
  | 'low_qual'
  | 'low_both'
  | 'low_weight'
  | 'cut_interest_cap'
  | 'cut_dedup'
  | 'cut_stretch_rank';

export interface RankerCandidate {
  candidateId: string;
  title: string | null;
  publishedAt: string | null;
  connectionScore: number | null;
  qualityScore: number | null;
  timeSensitivity: string | null;
  interestId: string | null;
  rank: number;
  // Carry-through display fields — never read by the ranker, but
  // surface so the orchestrator can build response payloads from the
  // verdict without re-querying candidate_pool.
  whyText?: string | null;
  guardVerdict?: string | null;
}

export interface RankerContext {
  now: Date;
  isKid: boolean;
  prefilledTitles: string[];
  prefilledInterestCounts: Map<string, number>;
}

export interface RankerConfig {
  cap: number;
}

export interface Verdict {
  candidate: RankerCandidate;
  disposition: Disposition;
  weighted: number;
  fresh: number;
  dedupedAgainst?: string;
}

export function normalizeSensitivity(s: string | null | undefined): TimeSensitivity {
  if (typeof s !== 'string') return 'standard';
  const v = s.toLowerCase().trim();
  if (v === 'news' || v === 'evergreen') return v;
  return 'standard';
}

export function clampScore(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, n));
}

// Decay applied at surface time, picked per content type. A null/unknown
// sensitivity falls back to 'standard'.
export function freshnessMultiplier(
  publishedAt: string | null,
  sensitivity: string | null,
  now: Date,
): number {
  const days = publishedAt === null
    ? null
    : Math.floor((now.getTime() - new Date(publishedAt).getTime()) / 86_400_000);
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

  if (days <= 1) return 1.6;
  if (days <= 2) return 1.4;
  if (days <= 7) return 1.2;
  if (days <= 30) return 1.0;
  if (days <= 90) return 0.7;
  return 0.4;
}

// Brief §9a: weight = 1/sqrt(rank). Lower-ranked interests are down-
// weighted, not eliminated — the feed leans on top interests but lets
// niche ones surface when content is fresh and high quality.
export function rankWeight(rank: number): number {
  return 1 / Math.sqrt(Math.max(1, rank));
}

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

interface ScoredItem {
  candidate: RankerCandidate;
  weighted: number;
  fresh: number;
  floorDisposition: Disposition | null;
}

function score(candidate: RankerCandidate, now: Date): ScoredItem {
  const conn = candidate.connectionScore ?? 0;
  const qual = candidate.qualityScore ?? 0;
  const fresh = freshnessMultiplier(candidate.publishedAt, candidate.timeSensitivity, now);
  const weighted = conn * qual * fresh * rankWeight(candidate.rank);

  let floorDisposition: Disposition | null = null;
  const lowConn = conn < MIN_CONNECTION_SCORE;
  const lowQual = qual < MIN_QUALITY_SCORE;
  if (lowConn && lowQual) floorDisposition = 'low_both';
  else if (lowConn) floorDisposition = 'low_conn';
  else if (lowQual) floorDisposition = 'low_qual';
  else if (weighted < MIN_WEIGHTED_SCORE) floorDisposition = 'low_weight';

  return { candidate, weighted, fresh, floorDisposition };
}

interface SelectedToken {
  tokens: Set<string>;
  candidateId?: string;
}

type CutReason = 'cut_interest_cap' | 'cut_dedup' | 'cut_stretch_rank';

type PickOutcome =
  | { kind: 'pickable' }
  | { kind: 'cap' }
  | { kind: 'dedup'; dedupedAgainst?: string };

function attemptPick(
  item: ScoredItem,
  interestCounts: Map<string, number>,
  selectedTokens: SelectedToken[],
  maxPerInterest: number,
): PickOutcome {
  if (item.candidate.interestId) {
    const count = interestCounts.get(item.candidate.interestId) ?? 0;
    if (count >= maxPerInterest) return { kind: 'cap' };
  }

  if (item.candidate.title) {
    const tokens = titleTokens(item.candidate.title);
    for (const existing of selectedTokens) {
      if (jaccardSimilarity(tokens, existing.tokens) >= TITLE_SIMILARITY_THRESHOLD) {
        const out: PickOutcome = { kind: 'dedup' };
        if (existing.candidateId !== undefined) out.dedupedAgainst = existing.candidateId;
        return out;
      }
    }
  }

  return { kind: 'pickable' };
}

function commit(
  item: ScoredItem,
  slot: 'regular' | 'stretch',
  picks: Map<string, 'regular' | 'stretch'>,
  interestCounts: Map<string, number>,
  selectedTokens: SelectedToken[],
): void {
  picks.set(item.candidate.candidateId, slot);
  if (item.candidate.interestId) {
    interestCounts.set(
      item.candidate.interestId,
      (interestCounts.get(item.candidate.interestId) ?? 0) + 1,
    );
  }
  if (item.candidate.title) {
    selectedTokens.push({
      tokens: titleTokens(item.candidate.title),
      candidateId: item.candidate.candidateId,
    });
  }
}

interface RefusalEntry {
  reason: CutReason;
  dedupedAgainst?: string;
}

// Two-pass slot allocation. Regular pass walks every eligible item in
// weighted-desc order, recording a refusal (cap before dedup) for every
// item that can't be picked, and committing picks until regular_quota
// fills. Stretch pass walks the leftovers: rank ≤ 3 yields cut_stretch_
// rank (rank > 3 reservation is the whole point of stretch slots); items
// past stretch_quota that *could* have fit also get cut_stretch_rank
// since the stretch reservation is what bounds total picks.
//
// First refusal per candidate wins — a candidate that hits both
// interest_cap (regular) and stretch_rank (stretch) gets cut_interest_cap.
function allocate(
  scored: ScoredItem[],
  context: RankerContext,
  config: RankerConfig,
): Map<string, { disposition: Exclude<Disposition, 'low_conn' | 'low_qual' | 'low_both' | 'low_weight'>; dedupedAgainst?: string }> {
  const { cap } = config;
  const stretchQuota = Math.max(1, Math.floor(cap * 0.2));
  const regularQuota = Math.max(0, cap - stretchQuota);
  const maxPerInterest = context.isKid ? MAX_PER_INTEREST_KID : MAX_PER_INTEREST_ADULT;

  const eligible = scored.filter((s) => s.floorDisposition === null);
  const picks = new Map<string, 'regular' | 'stretch'>();
  const refusals = new Map<string, RefusalEntry>();
  const interestCounts = new Map(context.prefilledInterestCounts);
  const selectedTokens: SelectedToken[] = context.prefilledTitles
    .filter((t) => t.length > 0)
    .map((t) => ({ tokens: titleTokens(t) }));

  let regularPicked = 0;
  for (const item of eligible) {
    const outcome = attemptPick(item, interestCounts, selectedTokens, maxPerInterest);
    if (outcome.kind === 'pickable') {
      if (regularPicked < regularQuota) {
        commit(item, 'regular', picks, interestCounts, selectedTokens);
        regularPicked++;
      }
    } else if (outcome.kind === 'cap') {
      refusals.set(item.candidate.candidateId, { reason: 'cut_interest_cap' });
    } else {
      const entry: RefusalEntry = { reason: 'cut_dedup' };
      if (outcome.dedupedAgainst !== undefined) entry.dedupedAgainst = outcome.dedupedAgainst;
      refusals.set(item.candidate.candidateId, entry);
    }
  }

  let stretchPicked = 0;
  for (const item of eligible) {
    if (picks.has(item.candidate.candidateId)) continue;

    if (item.candidate.rank <= 3) {
      if (!refusals.has(item.candidate.candidateId)) {
        refusals.set(item.candidate.candidateId, { reason: 'cut_stretch_rank' });
      }
      continue;
    }

    const outcome = attemptPick(item, interestCounts, selectedTokens, maxPerInterest);
    if (outcome.kind === 'pickable') {
      if (stretchPicked < stretchQuota) {
        commit(item, 'stretch', picks, interestCounts, selectedTokens);
        stretchPicked++;
      } else if (!refusals.has(item.candidate.candidateId)) {
        refusals.set(item.candidate.candidateId, { reason: 'cut_stretch_rank' });
      }
    } else if (!refusals.has(item.candidate.candidateId)) {
      if (outcome.kind === 'cap') {
        refusals.set(item.candidate.candidateId, { reason: 'cut_interest_cap' });
      } else {
        const entry: RefusalEntry = { reason: 'cut_dedup' };
        if (outcome.dedupedAgainst !== undefined) entry.dedupedAgainst = outcome.dedupedAgainst;
        refusals.set(item.candidate.candidateId, entry);
      }
    }
  }

  const result = new Map<string, { disposition: Exclude<Disposition, 'low_conn' | 'low_qual' | 'low_both' | 'low_weight'>; dedupedAgainst?: string }>();
  for (const item of eligible) {
    const slot = picks.get(item.candidate.candidateId);
    if (slot) {
      result.set(item.candidate.candidateId, { disposition: slot });
      continue;
    }
    const refusal = refusals.get(item.candidate.candidateId);
    if (refusal) {
      const entry: { disposition: CutReason; dedupedAgainst?: string } = { disposition: refusal.reason };
      if (refusal.dedupedAgainst !== undefined) entry.dedupedAgainst = refusal.dedupedAgainst;
      result.set(item.candidate.candidateId, entry);
      continue;
    }
    // Defensive fallback: two passes should always classify every
    // eligible item, but if something slips through, treat it as a
    // stretch-slot loser rather than letting the caller see undefined.
    result.set(item.candidate.candidateId, { disposition: 'cut_stretch_rank' });
  }
  return result;
}

export function rank(
  candidates: RankerCandidate[],
  context: RankerContext,
  config: RankerConfig,
): Verdict[] {
  const scored = candidates
    .map((c) => score(c, context.now))
    .sort((a, b) => b.weighted - a.weighted);
  const allocations = allocate(scored, context, config);

  return scored.map((s): Verdict => {
    if (s.floorDisposition !== null) {
      return { candidate: s.candidate, disposition: s.floorDisposition, weighted: s.weighted, fresh: s.fresh };
    }
    const a = allocations.get(s.candidate.candidateId);
    if (!a) {
      // Unreachable: every eligible item is in the allocation map.
      return { candidate: s.candidate, disposition: 'cut_stretch_rank', weighted: s.weighted, fresh: s.fresh };
    }
    const v: Verdict = { candidate: s.candidate, disposition: a.disposition, weighted: s.weighted, fresh: s.fresh };
    if (a.dedupedAgainst !== undefined) v.dedupedAgainst = a.dedupedAgainst;
    return v;
  });
}
