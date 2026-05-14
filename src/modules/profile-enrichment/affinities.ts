import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { WATCHED_RATIO, WATCHED_TIME_FLOOR_S } from '../watch-events';

// Layer 4 (brief §9a): Gemma-generated statements describing the shape of a
// user's preference. Internal v1 — surfaced indirectly via discovery's
// scoring/why-text prompt. We keep the regeneration logic isolated from the
// nightly snapshot/trust recompute (index.ts) because Gemma is the slow part
// and the weekly cadence is independent.

// Eligibility gate (brief §9a + issue #59): we only run Gemma for users with
// real engagement history. ≥30 lifetime watch events keeps a brand-new kid
// from getting "Likes …" statements built off two opens.
export const AFFINITY_MIN_LIFETIME_EVENTS = 30;

// Bounds requested in the brief — fewer than three is anecdotal, more than
// seven outruns the digest's evidence base.
const STATEMENT_MIN = 3;
const STATEMENT_MAX = 7;

// Digest size knobs. Top-n persons + top-n interests + a handful of sample
// titles is what the digest aggregates; small numbers keep the prompt bounded
// on a model running locally on the M4.
const TOP_PERSONS = 5;
const TOP_INTERESTS = 5;
const SAMPLE_TITLES_PER_BUCKET = 5;

export type EvidenceRefType = 'content_item' | 'person' | 'interest';

interface EvidenceRef {
  refType: EvidenceRefType;
  refId: string;
  note?: string;
}

interface AffinityStatement {
  statement: string;
  confidence: number;
  evidence: EvidenceRef[];
}

interface DigestPerson {
  personId: string;
  displayName: string | null;
  watchedCount: number;
  dismissedCount: number;
}

interface DigestInterest {
  interestId: string;
  label: string | null;
  watchedCount: number;
}

interface DigestSampleTitle {
  bucket: 'watched' | 'dismissed';
  title: string;
}

export interface AffinityDigest {
  userId: string;
  topWatched: DigestPerson[];
  topDismissed: DigestPerson[];
  perInterest: DigestInterest[];
  sampleTitles: DigestSampleTitle[];
}

// ── Eligibility ────────────────────────────────────────────────────────────────

interface EligibilityRow {
  role: string;
  events: number;
}

export interface AffinityEligibility {
  eligible: boolean;
  reason?: 'role' | 'too_few_events' | 'user_missing';
  role?: string;
  events?: number;
}

export function checkAffinityEligibility(userId: string): AffinityEligibility {
  const row = db.prepare(`
    SELECT u.role AS role,
           (SELECT COUNT(*) FROM watch_events we WHERE we.user_id = u.user_id) AS events
    FROM users u
    WHERE u.user_id = ?
  `).get(userId) as EligibilityRow | undefined;

  if (!row) return { eligible: false, reason: 'user_missing' };
  if (row.role !== 'kid' && row.role !== 'parent') {
    return { eligible: false, reason: 'role', role: row.role, events: row.events };
  }
  if (row.events < AFFINITY_MIN_LIFETIME_EVENTS) {
    return { eligible: false, reason: 'too_few_events', role: row.role, events: row.events };
  }
  return { eligible: true, role: row.role, events: row.events };
}

// ── Digest build ───────────────────────────────────────────────────────────────
//
// The digest is the synchronous SQL feed the Gemma prompt is built from. We
// keep it in plain better-sqlite3 selects (rather than CTEs the size of the
// snapshot recompute) because the input rows are already aggregated in
// behavioural_signals and the per-interest read is small.

export function buildAffinityDigest(userId: string): AffinityDigest {
  const topWatched = db.prepare(`
    SELECT bs.person_id      AS personId,
           p.display_name    AS displayName,
           bs.watched_count  AS watchedCount,
           bs.dismissed_count AS dismissedCount
    FROM behavioural_signals bs
    INNER JOIN people p ON p.person_id = bs.person_id
    WHERE bs.user_id = ? AND bs.watched_count > 0
    ORDER BY bs.watched_count DESC, p.display_name ASC
    LIMIT ?
  `).all(userId, TOP_PERSONS) as DigestPerson[];

  const topDismissed = db.prepare(`
    SELECT bs.person_id      AS personId,
           p.display_name    AS displayName,
           bs.watched_count  AS watchedCount,
           bs.dismissed_count AS dismissedCount
    FROM behavioural_signals bs
    INNER JOIN people p ON p.person_id = bs.person_id
    WHERE bs.user_id = ? AND bs.dismissed_count > 0
    ORDER BY bs.dismissed_count DESC, p.display_name ASC
    LIMIT ?
  `).all(userId, TOP_PERSONS) as DigestPerson[];

  // Per-interest counts: we go via candidate_pool, which is where the
  // interest tag lives. watch_events has no interest_id directly, so we
  // join requests → candidate_pool on youtube_id. Watched-threshold logic
  // matches recomputeBehaviouralSnapshot so the same events count.
  const perInterest = db.prepare(`
    SELECT cp.interest_id           AS interestId,
           i.label                  AS label,
           COUNT(DISTINCT we.event_id) AS watchedCount
    FROM watch_events we
    INNER JOIN requests r       ON r.request_id = we.request_id
    INNER JOIN candidate_pool cp ON cp.user_id = we.user_id
                                AND cp.external_id = r.youtube_id
    INNER JOIN interests i      ON i.id = cp.interest_id
    WHERE we.user_id = @user_id
      AND cp.interest_id IS NOT NULL
      AND (
        we.reason = 'ended'
        OR (we.duration_s > 0 AND CAST(we.position_s AS REAL) / we.duration_s >= @watched_ratio)
        OR we.position_s >= @watched_floor
      )
    GROUP BY cp.interest_id
    ORDER BY watchedCount DESC, i.label ASC
    LIMIT @limit
  `).all({
    user_id: userId,
    watched_ratio: WATCHED_RATIO,
    watched_floor: WATCHED_TIME_FLOOR_S,
    limit: TOP_INTERESTS,
  }) as DigestInterest[];

  // Sample titles from each end of the engagement spectrum. The "watched"
  // bucket pulls long-completion plays; the "dismissed" bucket pulls
  // explicit dismisses. We cap at SAMPLE_TITLES_PER_BUCKET so the prompt
  // doesn't blow up on a heavy user.
  const sampleWatched = db.prepare(`
    SELECT DISTINCT r.title AS title
    FROM watch_events we
    INNER JOIN requests r ON r.request_id = we.request_id
    WHERE we.user_id = ?
      AND r.title IS NOT NULL
      AND (
        we.reason = 'ended'
        OR (we.duration_s > 0 AND CAST(we.position_s AS REAL) / we.duration_s >= ?)
        OR we.position_s >= ?
      )
    ORDER BY we.started_at DESC
    LIMIT ?
  `).all(userId, WATCHED_RATIO, WATCHED_TIME_FLOOR_S, SAMPLE_TITLES_PER_BUCKET) as Array<{ title: string }>;

  const sampleDismissed = db.prepare(`
    SELECT DISTINCT r.title AS title
    FROM watch_events we
    INNER JOIN requests r ON r.request_id = we.request_id
    WHERE we.user_id = ?
      AND we.reason = 'dismissed'
      AND r.title IS NOT NULL
    ORDER BY we.started_at DESC
    LIMIT ?
  `).all(userId, SAMPLE_TITLES_PER_BUCKET) as Array<{ title: string }>;

  const sampleTitles: DigestSampleTitle[] = [
    ...sampleWatched.map((r): DigestSampleTitle => ({ bucket: 'watched', title: r.title })),
    ...sampleDismissed.map((r): DigestSampleTitle => ({ bucket: 'dismissed', title: r.title })),
  ];

  return {
    userId,
    topWatched,
    topDismissed,
    perInterest,
    sampleTitles,
  };
}

// ── Prompt + parser ────────────────────────────────────────────────────────────

export function buildAffinityPrompt(digest: AffinityDigest): string {
  const fmtPerson = (p: DigestPerson) =>
    `  - ${p.displayName ?? '(unknown)'} [id=${p.personId}] — watched ${p.watchedCount}, dismissed ${p.dismissedCount}`;
  const fmtInterest = (i: DigestInterest) =>
    `  - ${i.label ?? '(unknown)'} [id=${i.interestId}] — ${i.watchedCount} watched`;

  const watchedTitles = digest.sampleTitles.filter((t) => t.bucket === 'watched');
  const dismissedTitles = digest.sampleTitles.filter((t) => t.bucket === 'dismissed');

  const watchedSection = digest.topWatched.length > 0
    ? digest.topWatched.map(fmtPerson).join('\n')
    : '  (none)';
  const dismissedSection = digest.topDismissed.length > 0
    ? digest.topDismissed.map(fmtPerson).join('\n')
    : '  (none)';
  const interestSection = digest.perInterest.length > 0
    ? digest.perInterest.map(fmtInterest).join('\n')
    : '  (none)';
  const watchedSamples = watchedTitles.length > 0
    ? watchedTitles.map((t) => `  - ${t.title}`).join('\n')
    : '  (none)';
  const dismissedSamples = dismissedTitles.length > 0
    ? dismissedTitles.map((t) => `  - ${t.title}`).join('\n')
    : '  (none)';

  return `You are profiling a user's media preferences for an internal recommendation system. From the digest below, return ${STATEMENT_MIN}–${STATEMENT_MAX} short statements about the shape of their preference.

Top-watched people:
${watchedSection}

Top-dismissed people:
${dismissedSection}

Per-interest watched counts:
${interestSection}

Recent watched titles:
${watchedSamples}

Recent dismissed titles:
${dismissedSamples}

Each statement must:
- Be a single short sentence describing a pattern, not a list.
- Cite evidence using the ids from above ("person" for a [id=…] under people, "interest" for an [id=…] under interests). If a statement is grounded in a specific title, use ref_type "content_item" with the title as the ref_id.
- Carry a confidence between 0.0 and 1.0 — strong patterns close to 1.0, hedged guesses near 0.3.

Return ONLY this JSON, no other text:
{"statements":[{"statement":"…","confidence":0.8,"evidence":[{"ref_type":"person","ref_id":"<uuid>","note":"optional"}]}]}

Prefer statements that contrast watched vs dismissed, name an interest, or describe a duration/style pattern. Skip filler statements with no evidence.`;
}

interface RawEvidence { ref_type?: unknown; ref_id?: unknown; note?: unknown }
interface RawStatement { statement?: unknown; confidence?: unknown; evidence?: unknown }
interface RawShape { statements?: unknown }

export function parseAffinityResponse(raw: string): AffinityStatement[] | null {
  return parseOllamaJson<AffinityStatement[]>(raw, 'object', (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as RawShape;
    if (!Array.isArray(shape.statements)) return null;

    const out: AffinityStatement[] = [];
    for (const entry of shape.statements as RawStatement[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const statement = entry.statement;
      const confidence = entry.confidence;
      if (typeof statement !== 'string' || statement.trim().length === 0) continue;
      if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;

      const evidence: EvidenceRef[] = [];
      if (Array.isArray(entry.evidence)) {
        for (const ev of entry.evidence as RawEvidence[]) {
          if (typeof ev !== 'object' || ev === null) continue;
          const refType = ev.ref_type;
          const refId = ev.ref_id;
          if (refType !== 'content_item' && refType !== 'person' && refType !== 'interest') continue;
          if (typeof refId !== 'string' || refId.trim().length === 0) continue;
          const note = typeof ev.note === 'string' ? ev.note : undefined;
          evidence.push({ refType, refId, note });
        }
      }

      out.push({
        statement: statement.trim(),
        confidence: Math.min(1, Math.max(0, confidence)),
        evidence,
      });
    }

    if (out.length === 0) return null;
    return out;
  });
}

// ── Persistence ────────────────────────────────────────────────────────────────

interface PersistResult {
  superseded: number;
  inserted: number;
  evidenceInserted: number;
}

export function persistAffinities(
  userId: string,
  statements: AffinityStatement[],
  nowIso: string = new Date().toISOString(),
): PersistResult {
  const supersedeStmt = db.prepare(`
    UPDATE inferred_affinities
    SET superseded_at = ?
    WHERE user_id = ? AND superseded_at IS NULL
  `);
  const insertAffinity = db.prepare(`
    INSERT INTO inferred_affinities
      (affinity_id, user_id, statement, confidence, generated_at, superseded_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `);
  const insertEvidence = db.prepare(`
    INSERT INTO affinity_evidence
      (evidence_id, affinity_id, ref_type, ref_id, note)
    VALUES (?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let evidenceInserted = 0;
  let superseded = 0;

  const tx = db.transaction(() => {
    const supRes = supersedeStmt.run(nowIso, userId);
    superseded = supRes.changes;

    for (const s of statements) {
      const affinityId = uuidv7();
      insertAffinity.run(affinityId, userId, s.statement, s.confidence, nowIso);
      inserted += 1;
      for (const ev of s.evidence) {
        insertEvidence.run(uuidv7(), affinityId, ev.refType, ev.refId, ev.note ?? null);
        evidenceInserted += 1;
      }
    }
  });
  tx();

  return { superseded, inserted, evidenceInserted };
}

// ── Top-level entry point ──────────────────────────────────────────────────────

export interface RegenerateAffinitiesResult {
  userId: string;
  skipped: boolean;
  skipReason?: AffinityEligibility['reason'] | 'gemma_failed' | 'parse_failed' | 'empty_digest';
  statementCount: number;
  evidenceCount: number;
  supersededCount: number;
}

// Reads the digest, asks Gemma for statements, full-replaces the user's
// inferred_affinities rows. The supersede + insert is one transaction so the
// table never observes a window where the user has no active affinities.
export async function regenerateAffinities(userId: string): Promise<RegenerateAffinitiesResult> {
  const eligibility = checkAffinityEligibility(userId);
  if (!eligibility.eligible) {
    return {
      userId,
      skipped: true,
      skipReason: eligibility.reason,
      statementCount: 0,
      evidenceCount: 0,
      supersededCount: 0,
    };
  }

  const digest = buildAffinityDigest(userId);
  const hasSignal =
    digest.topWatched.length > 0 ||
    digest.topDismissed.length > 0 ||
    digest.perInterest.length > 0 ||
    digest.sampleTitles.length > 0;
  if (!hasSignal) {
    return {
      userId,
      skipped: true,
      skipReason: 'empty_digest',
      statementCount: 0,
      evidenceCount: 0,
      supersededCount: 0,
    };
  }

  const prompt = buildAffinityPrompt(digest);

  let raw: string;
  try {
    raw = await ollamaGenerate(prompt, undefined, undefined, {
      num_predict: 1200,
      temperature: 0.2,
    });
  } catch (err) {
    logger.warn({ err, userId }, 'Affinities: Gemma call failed');
    return {
      userId,
      skipped: true,
      skipReason: 'gemma_failed',
      statementCount: 0,
      evidenceCount: 0,
      supersededCount: 0,
    };
  }

  const parsed = parseAffinityResponse(raw);
  if (!parsed) {
    logger.warn({ userId, raw: raw.slice(0, 200) }, 'Affinities: could not parse Gemma response');
    return {
      userId,
      skipped: true,
      skipReason: 'parse_failed',
      statementCount: 0,
      evidenceCount: 0,
      supersededCount: 0,
    };
  }

  // Cap at STATEMENT_MAX even if Gemma returned more, and drop empties.
  const accepted = parsed.slice(0, STATEMENT_MAX);
  const persisted = persistAffinities(userId, accepted);

  logger.info(
    {
      userId,
      statementCount: persisted.inserted,
      evidenceCount: persisted.evidenceInserted,
      supersededCount: persisted.superseded,
    },
    'Affinities: regenerated',
  );

  return {
    userId,
    skipped: false,
    statementCount: persisted.inserted,
    evidenceCount: persisted.evidenceInserted,
    supersededCount: persisted.superseded,
  };
}

// ── Read helper (consumer side) ────────────────────────────────────────────────

export interface ActiveAffinity {
  affinityId: string;
  statement: string;
  confidence: number;
}

// Returns the top-N active (non-superseded) affinities for a user, ordered by
// confidence DESC. Consumers (discovery scoring, why-text prompt) call this
// at the start of a batch so the per-candidate path stays a pure formatter.
export function readActiveAffinities(userId: string, limit: number): ActiveAffinity[] {
  const rows = db.prepare(`
    SELECT affinity_id AS affinityId,
           statement,
           confidence
    FROM inferred_affinities
    WHERE user_id = ? AND superseded_at IS NULL
    ORDER BY confidence DESC, generated_at DESC
    LIMIT ?
  `).all(userId, limit) as ActiveAffinity[];
  return rows;
}
