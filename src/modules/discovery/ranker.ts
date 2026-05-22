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
//
// ADR-0009: the slate is composed from three buckets keyed off
// `sourceType` — subscription / back-catalogue / delighter. Each bucket
// has a fixed quota (a floor that is also a ceiling): back-catalogue 4,
// delighter 2, subscription `cap − 6`. Spare in one bucket is NEVER soaked
// into another, so a thin-supply day yields a genuinely short slate —
// valid per Scarcity. The only kid/adult difference is the guard recheck
// upstream; the numbers here are role-blind.

// Hard floors. Items below either single-axis floor never enter slot
// competition; the weighted floor catches the case where a high-axis
// score is wiped out by old freshness or low rank weight (e.g. a 2-year-
// old "news" item still scoring conn 9 / qual 6 → weighted ≈ 2.7).
export const MIN_CONNECTION_SCORE = 6;
export const MIN_QUALITY_SCORE = 5;
export const MIN_WEIGHTED_SCORE = 5;

// Diversity rules unified to role-blind numbers (ADR-0009). 3-per-interest
// with ~13 interests still leaves room for ≥5 distinct interests in a full
// slate; 2-per-channel stops one creator stacking the slate via multiple
// interests. The per-channel cap applies to every bucket (including
// subscriptions); the per-interest cap applies only to back-catalogue and
// delighter — following a person is an explicit choice an inferred-interest
// grouping must not suppress.
export const MAX_PER_INTEREST = 3;
export const MAX_PER_CHANNEL = 2;

// Fixed per-bucket quotas (ADR-0009). Floors that are also ceilings:
// back-catalogue and delighter reserve these slots every day; the
// subscription bucket fills the remainder up to the per-user cap. The two
// fixed buckets total 6, so subscriptions get `cap − 6`. A bucket with
// thinner supply than its quota yields fewer picks — the spare is not
// reallocated.
export const BACK_CATALOG_QUOTA = 4;
export const DELIGHTER_QUOTA = 2;

const TITLE_SIMILARITY_THRESHOLD = 0.4;

// Bucket keys derived from candidate_pool.source_type. Subscriptions and
// back-catalogue are both follow-provenance; the delighter is declared-
// interest search (interest_search). An unknown/null source_type falls into
// the delighter bucket — it has no follow provenance, so it competes for the
// exploration slot rather than a reserved follow slot.
export type Bucket = 'subscription' | 'back_catalog' | 'delighter';

export function bucketFor(sourceType: string | null): Bucket {
  if (sourceType === 'subscription') return 'subscription';
  if (sourceType === 'person_backcatalog') return 'back_catalog';
  return 'delighter';
}

const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'how', 'what',
  'why', 'this', 'that', 'these', 'those', 'just', 'will', 'from', 'into',
  'about', 'over', 'than', 'when', 'where', 'best',
]);

export type TimeSensitivity = 'news' | 'standard' | 'evergreen';

// Picked dispositions are the bucket names (ADR-0009) — a card's disposition
// tells you which slot it won, not a generic regular/stretch tier. Cut
// reasons explain why an eligible item lost.
export type Disposition =
  | 'subscription'
  | 'back_catalog'
  | 'delighter'
  | 'low_conn'
  | 'low_qual'
  | 'low_both'
  | 'low_weight'
  | 'cut_interest_cap'
  | 'cut_channel_cap'
  | 'cut_dedup'
  | 'cut_quota';

// The picked dispositions, shared so every caller that asks "did this card
// win a slot?" reads the same set. Surface (write-back) and the discovery
// orchestrator (auto-create-request) both import `isPicked` so they can't
// drift on which dispositions count as picks.
export const PICKED_DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>([
  'subscription',
  'back_catalog',
  'delighter',
]);

export function isPicked(disposition: Disposition): boolean {
  return PICKED_DISPOSITIONS.has(disposition);
}

export interface RankerCandidate {
  candidateId: string;
  title: string | null;
  publishedAt: string | null;
  connectionScore: number | null;
  qualityScore: number | null;
  timeSensitivity: string | null;
  // candidate_pool.source_type, threaded so the allocator can bucket. Null
  // (no source_type known) falls into the delighter bucket via bucketFor.
  sourceType: string | null;
  interestId: string | null;
  // Channel display name from candidate_pool.channel — used for the
  // per-channel diversity cap. Null means "channel unknown" and the
  // cap doesn't apply (treated like a null interestId).
  channel: string | null;
  rank: number;
  // Carry-through display fields — never read by the ranker, but
  // surface so the orchestrator can build response payloads from the
  // verdict without re-querying candidate_pool. `url` / `externalId`
  // also feed the auto-create-request step in runDiscoveryForUser.
  whyText?: string | null;
  guardVerdict?: string | null;
  url?: string;
  externalId?: string | null;
}

// Numbers are role-blind (ADR-0009) so the ranker no longer takes `isKid` —
// the only kid/adult difference (the guard recheck) happens upstream before
// candidates ever reach here.
export interface RankerContext {
  now: Date;
  prefilledTitles: string[];
  // Mid-day prefill so a second run doesn't re-pile from the same interest /
  // channel that earlier picks already consumed. Bucket quotas are also
  // prefilled (see prefilledBucketCounts) so a mid-day top-up respects what
  // each bucket already spent.
  prefilledInterestCounts: Map<string, number>;
  // Mid-day prefill for the per-channel cap (issue #148). Same shape
  // as prefilledInterestCounts: keyed by the channel display name
  // already surfaced today. Optional so callers that haven't migrated
  // yet behave as if no channels were prefilled.
  prefilledChannelCounts?: Map<string, number>;
  // Mid-day prefill for the per-bucket quotas. Keyed by bucket name; counts
  // the picks already surfaced today per bucket so a second run tops up to
  // the quota rather than re-spending the whole allowance. Optional —
  // callers that don't pass it behave as if no buckets were prefilled.
  prefilledBucketCounts?: Map<Bucket, number>;
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
  bucket: Bucket;
  floorDisposition: Disposition | null;
}

function score(candidate: RankerCandidate, now: Date): ScoredItem {
  const conn = candidate.connectionScore ?? 0;
  const qual = candidate.qualityScore ?? 0;
  const fresh = freshnessMultiplier(candidate.publishedAt, candidate.timeSensitivity, now);
  const bucket = bucketFor(candidate.sourceType);

  // ADR-0009: follow-provenance buckets (subscription + back-catalogue) force
  // rankWeight to 1.0 — neither is penalised by an inferred interest's rank,
  // because following a person is the explicit signal. Only the delighter
  // keeps rankWeight(interest_rank), since it leans on declared-interest rank.
  const weight = bucket === 'delighter' ? rankWeight(candidate.rank) : 1.0;
  const weighted = conn * qual * fresh * weight;

  let floorDisposition: Disposition | null = null;
  const lowConn = conn < MIN_CONNECTION_SCORE;
  const lowQual = qual < MIN_QUALITY_SCORE;
  if (lowConn && lowQual) floorDisposition = 'low_both';
  else if (lowConn) floorDisposition = 'low_conn';
  else if (lowQual) floorDisposition = 'low_qual';
  else if (weighted < MIN_WEIGHTED_SCORE) floorDisposition = 'low_weight';

  return { candidate, weighted, fresh, bucket, floorDisposition };
}

interface SelectedToken {
  tokens: Set<string>;
  candidateId?: string;
}

type CutReason = 'cut_interest_cap' | 'cut_channel_cap' | 'cut_dedup' | 'cut_quota';

// A picked disposition is the bucket name; a cut disposition is a CutReason.
type PickedDisposition = 'subscription' | 'back_catalog' | 'delighter';

function bucketDisposition(bucket: Bucket): PickedDisposition {
  return bucket;
}

type PickOutcome =
  | { kind: 'pickable' }
  | { kind: 'cap_interest' }
  | { kind: 'cap_channel' }
  | { kind: 'quota' }
  | { kind: 'dedup'; dedupedAgainst?: string };

// Diversity + dedup gate, evaluated in a fixed order so the reported refusal
// reason is deterministic when several would apply:
//   1. per-channel cap (global, every bucket incl. subscriptions)
//   2. per-interest cap (back-catalogue + delighter only — NOT subscriptions)
//   3. title dedup (global)
// Channel before interest preserves issue #148's "per-channel cap wins".
// Subscriptions skip the interest cap (ADR-0009): following a person is an
// explicit choice an inferred-interest grouping must not suppress.
function attemptPick(
  item: ScoredItem,
  interestCounts: Map<string, number>,
  channelCounts: Map<string, number>,
  selectedTokens: SelectedToken[],
): PickOutcome {
  if (item.candidate.channel) {
    const count = channelCounts.get(item.candidate.channel) ?? 0;
    if (count >= MAX_PER_CHANNEL) return { kind: 'cap_channel' };
  }

  if (item.bucket !== 'subscription' && item.candidate.interestId) {
    const count = interestCounts.get(item.candidate.interestId) ?? 0;
    if (count >= MAX_PER_INTEREST) return { kind: 'cap_interest' };
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
  picks: Map<string, PickedDisposition>,
  bucketCounts: Map<Bucket, number>,
  interestCounts: Map<string, number>,
  channelCounts: Map<string, number>,
  selectedTokens: SelectedToken[],
): void {
  picks.set(item.candidate.candidateId, bucketDisposition(item.bucket));
  bucketCounts.set(item.bucket, (bucketCounts.get(item.bucket) ?? 0) + 1);
  if (item.bucket !== 'subscription' && item.candidate.interestId) {
    interestCounts.set(
      item.candidate.interestId,
      (interestCounts.get(item.candidate.interestId) ?? 0) + 1,
    );
  }
  if (item.candidate.channel) {
    channelCounts.set(
      item.candidate.channel,
      (channelCounts.get(item.candidate.channel) ?? 0) + 1,
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

// Per-bucket fixed quotas (ADR-0009). In the normal case (cap ≥ 6):
// back-catalogue 4, delighter 2, subscription `cap − 6`. The fixed buckets are
// floors-that-are-also-ceilings.
//
// Degenerate small-cap guard: `daily_pick_cap` / DEFAULT_DAILY_PICK_CAP are
// only validated positive, so a cap below 6 is reachable config/user data.
// When the two fixed buckets wouldn't fit, they are clamped so the whole slate
// never exceeds the cap — back-catalogue keeps priority (filled first), then
// delighter takes whatever remains, then subscription gets nothing. The total
// of all three quotas is therefore always ≤ cap.
function bucketQuotas(cap: number): Record<Bucket, number> {
  const safeCap = Math.max(0, cap);
  const backCatalog = Math.min(BACK_CATALOG_QUOTA, safeCap);
  const delighter = Math.min(DELIGHTER_QUOTA, safeCap - backCatalog);
  const subscription = Math.max(0, safeCap - backCatalog - delighter);
  return { subscription, back_catalog: backCatalog, delighter };
}

// Single weighted-desc pass. Each eligible item competes for a slot in its
// own bucket; the bucket quota is the only thing that bounds total picks per
// bucket. Diversity caps (per-channel global, per-interest non-subscription)
// and title dedup are shared state across buckets, so a channel that already
// stacked two subscription slots can't also stack a delighter from the same
// creator. Spare in a thin bucket is NEVER soaked into another — when a
// bucket's quota is exhausted, further items in it report cut_quota and the
// slate is simply shorter. First refusal per candidate wins.
// Picked-or-cut disposition the allocator emits per eligible candidate. The
// floor dispositions (low_*) are decided in `score`, never here.
type AllocatedDisposition = PickedDisposition | CutReason;

function allocate(
  scored: ScoredItem[],
  context: RankerContext,
  config: RankerConfig,
): Map<string, { disposition: AllocatedDisposition; dedupedAgainst?: string }> {
  const quotas = bucketQuotas(config.cap);

  const eligible = scored.filter((s) => s.floorDisposition === null);
  const picks = new Map<string, PickedDisposition>();
  const refusals = new Map<string, RefusalEntry>();
  const interestCounts = new Map(context.prefilledInterestCounts);
  const channelCounts = new Map(context.prefilledChannelCounts ?? []);
  const bucketCounts = new Map<Bucket, number>(context.prefilledBucketCounts ?? []);
  const selectedTokens: SelectedToken[] = context.prefilledTitles
    .filter((t) => t.length > 0)
    .map((t) => ({ tokens: titleTokens(t) }));

  for (const item of eligible) {
    const outcome = attemptPick(item, interestCounts, channelCounts, selectedTokens);
    if (outcome.kind === 'pickable') {
      // Bucket-quota gate runs only once an item has cleared diversity +
      // dedup, so a quota-exhausted bucket reports cut_quota (not a cap
      // reason) and a slot is never burned by an item that would have been
      // cut anyway.
      const bucketPicked = bucketCounts.get(item.bucket) ?? 0;
      if (bucketPicked < quotas[item.bucket]) {
        commit(item, picks, bucketCounts, interestCounts, channelCounts, selectedTokens);
      } else {
        refusals.set(item.candidate.candidateId, { reason: 'cut_quota' });
      }
    } else if (outcome.kind === 'cap_channel') {
      refusals.set(item.candidate.candidateId, { reason: 'cut_channel_cap' });
    } else if (outcome.kind === 'cap_interest') {
      refusals.set(item.candidate.candidateId, { reason: 'cut_interest_cap' });
    } else if (outcome.kind === 'quota') {
      refusals.set(item.candidate.candidateId, { reason: 'cut_quota' });
    } else {
      const entry: RefusalEntry = { reason: 'cut_dedup' };
      if (outcome.dedupedAgainst !== undefined) entry.dedupedAgainst = outcome.dedupedAgainst;
      refusals.set(item.candidate.candidateId, entry);
    }
  }

  const result = new Map<string, { disposition: AllocatedDisposition; dedupedAgainst?: string }>();
  for (const item of eligible) {
    const slot = picks.get(item.candidate.candidateId);
    if (slot) {
      result.set(item.candidate.candidateId, { disposition: slot });
      continue;
    }
    const refusal = refusals.get(item.candidate.candidateId);
    if (refusal) {
      const entry: { disposition: AllocatedDisposition; dedupedAgainst?: string } = { disposition: refusal.reason };
      if (refusal.dedupedAgainst !== undefined) entry.dedupedAgainst = refusal.dedupedAgainst;
      result.set(item.candidate.candidateId, entry);
      continue;
    }
    // Defensive fallback: the single pass should classify every eligible
    // item, but if something slips through, treat it as a quota loser rather
    // than letting the caller see undefined.
    result.set(item.candidate.candidateId, { disposition: 'cut_quota' });
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
      return { candidate: s.candidate, disposition: 'cut_quota', weighted: s.weighted, fresh: s.fresh };
    }
    const v: Verdict = { candidate: s.candidate, disposition: a.disposition, weighted: s.weighted, fresh: s.fresh };
    if (a.dedupedAgainst !== undefined) v.dedupedAgainst = a.dedupedAgainst;
    return v;
  });
}
