import { db } from '../../db/client';
import { logger } from '../../logger';
import { WATCHED_RATIO, WATCHED_TIME_FLOOR_S } from '../watch-events';

// Drift observations (#161, ADR-0008, brief §10). Drift is the literacy
// surface — where the human is *told* about behavioural signal. It never
// edits the explicit profile. This module produces two observation types and
// writes them into the JSON `summary` column of the `drift` table; it never
// touches user_interests, interests, or inferred_affinities.
//
// Both observations are phrased observationally (no evaluation, no advice) per
// brief §10: a mirror to read, not a score to optimise.

// ── Observation types ───────────────────────────────────────────────────────

export type DriftObservationType = 'disagreement' | 'depth';

export interface DriftObservation {
  type: DriftObservationType;
  // The human-facing sentence shown in Drift. Observational, never evaluative.
  text: string;
  // Light structured context so a tap-through can resolve the evidence later.
  // Kept deliberately minimal — Drift is a mirror, not an API.
  refId?: string;
}

// The shape stored inside drift.summary. Additive: existing/future Drift
// content can live alongside `observations` under other keys without this
// module clobbering them (see persistDriftObservations).
export interface DriftSummary {
  observations?: DriftObservation[];
  [key: string]: unknown;
}

// ── Disagreement detection ──────────────────────────────────────────────────
//
// A declared interest (a stored user_interests row) the user consistently
// skips. Per ADR-0008 the interest's runtime weight already drops via
// behavioural signal; Drift just tells the human — it never deletes the row.
//
// Interest-level signal is derived deterministically (no Gemma):
//   watched   — watch_events that cross the watched threshold, joined to the
//               candidate that carried the interest tag.
//   dismissed — pre-play swipe-dismisses (candidate_pool.status='dismissed')
//               plus mid-play bailouts (watch_events.reason='dismissed'),
//               both via the interest tag on candidate_pool.

// Below this many total interactions the ratio is anecdotal — one bad week
// shouldn't read as a standing disagreement. Mirrors the spirit of the trust
// cold-start floor in profile-enrichment.
export const DISAGREEMENT_MIN_INTERACTIONS = 5;

// Dismissals must be at least this share of total interactions for the skip
// to count as "consistent". 0.7 means roughly two skips for every engage.
export const DISAGREEMENT_DISMISS_RATIO = 0.7;

interface InterestSignalRow {
  interestId: string;
  label: string | null;
  watchedCount: number;
  dismissedCount: number;
}

// [start, end) UTC ISO bounds for an ISO week label ("2026-W15"). Drift is a
// weekly mirror, so the disagreement read is scoped to the same week the
// observation is filed under — otherwise a one-off threshold crossing would
// re-report "this week you skipped …" every week forever. The window runs
// Monday 00:00:00 UTC to the next Monday 00:00:00 UTC.
export function isoWeekRange(week: string): { start: string; end: string } {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) throw new Error(`Invalid ISO week label: ${week}`);
  const year = Number(match[1]);
  const weekNo = Number(match[2]);

  // ISO week 1 contains the year's first Thursday; equivalently, the Monday of
  // week 1 is the Monday on or before Jan 4th. Start from Jan 4th, step back to
  // its Monday, then add (weekNo - 1) weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));

  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (weekNo - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);

  return { start: start.toISOString(), end: end.toISOString() };
}

// Returns declared interests for the user with their behavioural watched /
// dismissed counts within the given ISO week. Only declared interests
// (user_interests rows) are considered — an inferred-but-unkept interest has
// no declared row and so can't produce a disagreement. The week window keeps
// the read aligned with the "this week" framing of the observation copy.
export function readDeclaredInterestSignal(userId: string, week: string): InterestSignalRow[] {
  const { start, end } = isoWeekRange(week);
  return db.prepare(`
    WITH watched AS (
      -- Join watch_events to the candidate directly via the denormalised
      -- video_id (== candidate_pool.external_id). watch_events.video_id is
      -- kept specifically so behavioural signal survives request hard-delete
      -- (migration 021); routing through requests would drop it.
      SELECT cp.interest_id AS interest_id,
             COUNT(DISTINCT we.event_id) AS n
      FROM watch_events we
      INNER JOIN candidate_pool cp ON cp.user_id = we.user_id
                                  AND cp.external_id = we.video_id
      WHERE we.user_id = @user_id
        AND we.started_at >= @week_start AND we.started_at < @week_end
        AND cp.interest_id IS NOT NULL
        AND (
          we.reason = 'ended'
          OR (we.duration_s > 0 AND CAST(we.position_s AS REAL) / we.duration_s >= @watched_ratio)
          OR we.position_s >= @watched_floor
        )
      GROUP BY cp.interest_id
    ),
    dismissed AS (
      SELECT interest_id, COUNT(*) AS n FROM (
        -- Pre-play swipe-dismisses. candidate_pool has no dismissed_at, so we
        -- window on created_at — a candidate is created and swiped within the
        -- same surfacing cycle, so created_at is a sound week anchor.
        SELECT cp.candidate_id, cp.interest_id
        FROM candidate_pool cp
        WHERE cp.user_id = @user_id
          AND cp.status = 'dismissed'
          AND cp.created_at >= @week_start AND cp.created_at < @week_end
          AND cp.interest_id IS NOT NULL
        UNION
        -- Mid-play bailouts, attributed via the candidate's interest tag.
        -- Same direct video_id join as the watched CTE so a deleted request
        -- doesn't erase the dismissal signal.
        SELECT DISTINCT cp.candidate_id, cp.interest_id
        FROM watch_events we
        INNER JOIN candidate_pool cp ON cp.user_id = we.user_id
                                    AND cp.external_id = we.video_id
        WHERE we.user_id = @user_id
          AND we.started_at >= @week_start AND we.started_at < @week_end
          AND we.reason = 'dismissed'
          AND cp.interest_id IS NOT NULL
      )
      GROUP BY interest_id
    )
    SELECT i.id                   AS interestId,
           i.label                AS label,
           COALESCE(w.n, 0)       AS watchedCount,
           COALESCE(d.n, 0)       AS dismissedCount
    FROM user_interests ui
    INNER JOIN interests i ON i.id = ui.interest_id
    LEFT JOIN watched w    ON w.interest_id = ui.interest_id
    LEFT JOIN dismissed d  ON d.interest_id = ui.interest_id
    WHERE ui.user_id = @user_id
  `).all({
    user_id: userId,
    watched_ratio: WATCHED_RATIO,
    watched_floor: WATCHED_TIME_FLOOR_S,
    week_start: start,
    week_end: end,
  }) as InterestSignalRow[];
}

export function buildDisagreementObservations(userId: string, week: string = isoWeek()): DriftObservation[] {
  const rows = readDeclaredInterestSignal(userId, week);
  const out: DriftObservation[] = [];

  for (const row of rows) {
    const total = row.watchedCount + row.dismissedCount;
    if (total < DISAGREEMENT_MIN_INTERACTIONS) continue;
    const ratio = row.dismissedCount / total;
    if (ratio < DISAGREEMENT_DISMISS_RATIO) continue;

    const label = row.label ?? 'this interest';
    // Observational: states what happened, names no judgement, gives no advice.
    out.push({
      type: 'disagreement',
      text: `You listed ${label} as an interest, but this week you skipped most of the ${label} videos Eddy picked.`,
      refId: row.interestId,
    });
  }

  return out;
}

// ── Depth detection ─────────────────────────────────────────────────────────
//
// A level/depth pattern inferred from Layer 4 affinities ("tends toward
// long-form technical explainers"). Per ADR-0008 this is surfaced as an
// observation, never written back to user_interests.expertise. We read the
// already-generated affinity statements (the producer is profile-enrichment;
// this module is a pure consumer) and pick the ones that describe a depth /
// length / level pattern, rather than re-asking Gemma.

// Phrases that mark a statement as describing depth/length/level, rather than
// a topic or person preference. Matched case-insensitively against the
// statement text. Kept as whole-word-ish fragments to avoid over-matching.
const DEPTH_MARKERS: RegExp[] = [
  /\blong[\s-]?form\b/i,
  /\bin[\s-]?depth\b/i,
  /\bdeep[\s-]?dive[s]?\b/i,
  /\bdeep(?:er|ly)?\b/i,
  /\bdetailed\b/i,
  /\bexplainer[s]?\b/i,
  /\btechnical\b/i,
  /\badvanced\b/i,
  /\bbeginner\b/i,
  /\bshort[\s-]?form\b/i,
  /\bbite[\s-]?sized\b/i,
  /\bquick\b/i,
];

// Cap how many depth observations a single Drift run surfaces — more than a
// couple stops being a mirror and starts being a wall of text.
export const DEPTH_OBSERVATION_MAX = 2;

interface ActiveAffinityRow {
  affinityId: string;
  statement: string;
}

// Reads the user's active (non-superseded) affinity statements. We inline the
// SELECT rather than importing from profile-enrichment to keep drift a leaf of
// the import graph — same pattern discovery/scoring uses for the same table.
export function readActiveAffinityStatements(userId: string): ActiveAffinityRow[] {
  return db.prepare(`
    SELECT affinity_id AS affinityId, statement
    FROM inferred_affinities
    WHERE user_id = ? AND superseded_at IS NULL
    ORDER BY confidence DESC, generated_at DESC
  `).all(userId) as ActiveAffinityRow[];
}

function isDepthStatement(statement: string): boolean {
  return DEPTH_MARKERS.some((re) => re.test(statement));
}

export function buildDepthObservations(userId: string): DriftObservation[] {
  const rows = readActiveAffinityStatements(userId);
  const out: DriftObservation[] = [];

  for (const row of rows) {
    if (out.length >= DEPTH_OBSERVATION_MAX) break;
    if (!isDepthStatement(row.statement)) continue;

    // The affinity statement is already an observation about preference shape;
    // we surface it as the depth observation verbatim. It carries no advice or
    // evaluation by construction (the affinity prompt asks for pattern
    // descriptions, not judgements).
    out.push({
      type: 'depth',
      text: row.statement,
      refId: row.affinityId,
    });
  }

  return out;
}

// ── Compose + persist ───────────────────────────────────────────────────────

// ISO 8601 week label, e.g. "2026-W15", matching drift.week's documented
// format. Pure date arithmetic — no locale dependence.
export function isoWeek(date: Date = new Date()): string {
  // Copy so we don't mutate the caller's Date; work in UTC to stay locale-free.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weekday: Monday = 1 … Sunday = 7. Shift to the Thursday of this week
  // (the ISO week-year anchor), then count weeks from year start.
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function computeDriftObservations(userId: string, week: string = isoWeek()): DriftObservation[] {
  return [
    ...buildDisagreementObservations(userId, week),
    ...buildDepthObservations(userId),
  ];
}

export interface PersistDriftResult {
  userId: string;
  week: string;
  observationCount: number;
}

// Writes observations into drift.summary.observations for (user, week),
// preserving any other keys already in the summary JSON. This module owns the
// `observations` key only — it never overwrites the whole summary blob.
export function persistDriftObservations(
  userId: string,
  observations: DriftObservation[],
  week: string = isoWeek(),
  nowIso: string = new Date().toISOString(),
): PersistDriftResult {
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT summary FROM drift WHERE user_id = ? AND week = ?'
    ).get(userId, week) as { summary: string } | undefined;

    let summary: DriftSummary = {};
    if (existing) {
      try {
        const parsed = JSON.parse(existing.summary) as unknown;
        if (parsed && typeof parsed === 'object') summary = parsed as DriftSummary;
      } catch {
        logger.warn({ userId, week }, 'Drift: existing summary was not valid JSON, replacing');
      }
    }

    summary.observations = observations;
    const summaryJson = JSON.stringify(summary);

    db.prepare(`
      INSERT INTO drift (user_id, week, summary, calculated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, week)
      DO UPDATE SET summary = excluded.summary, calculated_at = excluded.calculated_at
    `).run(userId, week, summaryJson, nowIso);
  });
  tx();

  return { userId, week, observationCount: observations.length };
}

// Reads back the observations stored for (user, week). Returns [] when there
// is no drift row or no observations key.
export function readDriftObservations(userId: string, week: string = isoWeek()): DriftObservation[] {
  const row = db.prepare(
    'SELECT summary FROM drift WHERE user_id = ? AND week = ?'
  ).get(userId, week) as { summary: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.summary) as DriftSummary;
    return Array.isArray(parsed.observations) ? parsed.observations : [];
  } catch {
    return [];
  }
}

// Top-level entry point: compute both observation types for a user and persist
// them under the current ISO week. Returns the persist result.
export function generateDriftObservations(
  userId: string,
  week: string = isoWeek(),
): PersistDriftResult {
  const observations = computeDriftObservations(userId, week);
  const result = persistDriftObservations(userId, observations, week);
  logger.info(
    { userId, week, observationCount: result.observationCount },
    'Drift: observations generated',
  );
  return result;
}
