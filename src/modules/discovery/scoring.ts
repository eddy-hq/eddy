import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { formatAge, formatDuration } from './util';
import { clampScore, normalizeSensitivity, type TimeSensitivity } from './ranker';
import type { UserInterestRow } from './intake';

export type { TimeSensitivity };

// Trust-weight default when no followed_people row exists for a candidate's
// person (e.g. a back-catalog candidate whose follow was removed before
// scoring). Mirrors TRUST_DEFAULT in profile-enrichment/util.ts; kept inline
// here so scoring stays a leaf of the import graph and isn't dragged through
// the profile-enrichment scheduler module just to read a single fallback.
const TRUST_DEFAULT = 1.0;

interface CandidateRow {
  candidate_id: string;
  external_id: string | null;
  title: string | null;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  source_type: string;
  interest_id: string | null;
  interest_label: string | null;
  person_id: string | null;
  person_name: string | null;
  channel: string | null;
  duration_secs: number | null;
  interest_expertise: string | null;
}

interface ScoringItem {
  index: number;
  candidateId: string;
  title: string;
  channel: string;
  durationSecs: number | null;
  publishedAt: string | null;
  interestLabel: string | null;
  expertise: string | null;
  sourceType: string;
  personId: string | null;
  personName: string | null;
}

// Per-user trust weight for a followed person (issue #58). Returns
// TRUST_DEFAULT (1.0) when the user doesn't follow this person (e.g. a
// back-catalog candidate whose follow was removed before scoring ran).
// Lookup is per-candidate but the value is small and frequently repeated,
// so the cost is dominated by Gemma round-trips, not these point selects.
function lookupTrustWeight(userId: string, personId: string): number {
  const row = db.prepare(
    'SELECT trust_weight FROM followed_people WHERE user_id = ? AND person_id = ?'
  ).get(userId, personId) as { trust_weight: number | null } | undefined;
  if (!row || row.trust_weight === null) return TRUST_DEFAULT;
  return row.trust_weight;
}

// Active affinity statements for the user (issue #59, brief §9a Layer 4),
// ordered by confidence DESC. Capped at 5 so the prompt stays bounded. We
// inline the SELECT here (rather than importing from profile-enrichment) to
// keep scoring a leaf of the import graph — same pattern as the trust-weight
// fallback above. Profile-enrichment is the producer; this module is a pure
// consumer.
const AFFINITY_TOP_N = 5;
function lookupActiveAffinityStatements(userId: string): string[] {
  const rows = db.prepare(`
    SELECT statement
    FROM inferred_affinities
    WHERE user_id = ? AND superseded_at IS NULL
    ORDER BY confidence DESC, generated_at DESC
    LIMIT ?
  `).all(userId, AFFINITY_TOP_N) as Array<{ statement: string }>;
  return rows.map((r) => r.statement);
}

// Deterministic time-sensitivity override for patterns Gemma keeps flip-
// flopping on. Match highlights and dated sports content are unambiguously
// news; relying on the model gave inconsistent verdicts even at temp 0.2.
// Only override TOWARD news — never override Gemma down to standard.
export function overrideTimeSensitivity(title: string | null, modelSays: TimeSensitivity): TimeSensitivity {
  if (modelSays === 'news') return 'news';
  if (!title) return modelSays;
  const t = title.toLowerCase();

  // Match highlights, recap-style sports content
  if (/\bmatch highlights\b/.test(t)) return 'news';
  if (/\bhighlights\s*[|:]/.test(t)) return 'news';

  // Team-vs-team score patterns ("3-0", "5-1") with sport indicators
  if (/\b\d{1,2}[-–]\d{1,2}\b/.test(t) && /\b(vs\.?|match|full match|fc|united|city|town)\b/i.test(title)) {
    return 'news';
  }

  // Football season tags (e.g. "2024/25", "2025/26") — implies current season
  if (/\b20\d{2}\/2\d\b/.test(t)) return 'news';

  return modelSays;
}

export function buildScoringPrompt(
  items: ScoringItem[],
  interestSummary: string,
  affinityStatements: string[] = [],
): string {
  const videoList = items.map((item) => {
    const channel = item.channel ? item.channel : 'unknown channel';
    const seedTag = item.interestLabel
      ? ` [seeded by interest: "${item.interestLabel}"${item.expertise ? `, ${item.expertise}` : ''}]`
      : '';
    const followTag = item.personName && (item.sourceType === 'person_backcatalog' || item.sourceType === 'subscription')
      ? item.sourceType === 'subscription'
        ? ` [new upload from a person you follow: ${item.personName}]`
        : ` [back-catalog from a person you follow: ${item.personName}]`
      : '';
    return `${item.index}. "${item.title}" — ${channel} | ${formatDuration(item.durationSecs)} | ${formatAge(item.publishedAt)}${seedTag}${followTag}`;
  }).join('\n');

  // Layer 4 (brief §9a, issue #59): Gemma-inferred statements describing the
  // shape of the user's preference. The scoring prompt uses them as soft
  // priors — they don't override the interests list, but they let Gemma
  // explain a pick by name ("Likes long-form technical explainers") when
  // the title fits one. Empty array means a fresh user with no affinities
  // generated yet; section is omitted entirely so we don't waste tokens.
  const affinitySection = affinityStatements.length > 0
    ? `\nKnown preference patterns (you may cite one of these by name in "why"):\n${affinityStatements.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  return `Score YouTube videos for a personal discovery feed. For each video give a connection score, a quality score, a time-sensitivity tag, and a one-sentence reason in Eddy's voice.

User interests (priority order, expertise): ${interestSummary}
${affinitySection}
Videos (title — channel | length | age [seeded by interest] [back-catalog from a person you follow] [new upload from a person you follow]):
${videoList}

Return ONLY this JSON, one entry per video, no other text:
[{"index":1,"connection":7,"quality":8,"time_sensitivity":"standard","why":"A practical look at {specific aspect}, close to the way you have been exploring {grounding}."}]

CONNECTION (0–10): match to a named interest at the user's expertise level.
- 8–10: clearly and specifically matches a named interest
- 5–7: adjacent or partial match
- 0–4: weak or no clear match
If you can't articulate which interest matches and what specific aspect, score ≤ 3.

QUALITY (0–10): substance over engagement bait. Score quality ≤ 4 if the title contains any of these bait patterns:
- Money in title without specific company context — "$650M Exit", "Make $1M with X", "How I made $X"
- Cure-all framing — "Read this and win", "Watch this to know X", "The only X you need"
- ALL CAPS shouting or hyperbolic phrasing — "EXACTLY", "INSANE", "FAST", "SECRETS", "Don't waste"
- Parasocial framing — "How I'd build", "If I were starting over", "What I wish I knew"
- Year + Roadmap pairing where the year exists to look fresh — "Complete 2026 Roadmap"
- Mismatched duration — 60s shorts claiming complex skills, 30min for trivial topics
- Reaction or compilation-farm channels

Reward specificity (named techniques, specific scores, real expertise) and descriptive titles beyond a hook.

TIME_SENSITIVITY:
- "news": value drops within days — match highlights, "X just announced", recent dates
- "standard": tutorials, year-stamped roadmaps, trend pieces
- "evergreen": fundamentals, history, philosophy, classic retrospectives

For "why", write one warm, specific sentence that could sit above the card in Eddy's voice:
- Lead with the video's concrete value: the question, technique, perspective, match moment, build, argument, or explanation it contains.
- Tie that value to the user's taste in plain language, using "you" or "your" naturally.
- For followed people, use the person only when their style or perspective matters; otherwise explain the video itself.

Good shapes:
- "A concise look at the Southport shape after the red card, which fits your habit of watching the tactical side of York games."
- "Steve Mould's kind of hands-on physics explanation, but aimed at gyroscopes rather than the usual pressure or sound demos."

If the best reason would only be provenance, give a low connection score. The follow does not change the connection or quality scores; the user still has to want this specific video. Do not consider freshness or popularity in the scores — those are applied separately.`;
}

interface ScoreEntry { index: number; connection?: number; quality?: number; time_sensitivity?: string; why?: string; score?: number }

export function parseScoringVerdict(raw: string): ScoreEntry[] | null {
  const primary = parseOllamaJson<ScoreEntry[]>(raw, 'array', (parsed) =>
    Array.isArray(parsed) ? (parsed as ScoreEntry[]) : null,
  );
  if (primary) return primary;

  // Salvage path: when the model emits per-video objects with no surrounding
  // array, scrape them individually. Kept at the callsite since no other
  // helper consumer needs it.
  const objects = [...raw.matchAll(/\{[^{}]+\}/g)].map((m) => {
    try { return JSON.parse(m[0]) as ScoreEntry; } catch { return null; }
  }).filter((o): o is ScoreEntry => o !== null);
  return objects.length === 0 ? null : objects;
}

export function normalizeScoringWhy(title: string, why: string | undefined): string | null {
  const trimmed = why?.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === title.trim().toLowerCase()) return null;
  return trimmed;
}

export async function scoreCandidates(userId: string, userInterests: UserInterestRow[]): Promise<void> {
  // JOIN to surface the seeding interest's label + the user's expertise level
  // for that interest, so Gemma can name the connection specifically rather
  // than guess from a list of interests.
  // Score in bucket-priority order, not raw created_at DESC (ADR-0009). The
  // discovery job polls subscriptions first, then seeds back-catalogue, then
  // runs a full interest-search budget — so on a busy run the high-volume
  // interest-search rows have the newest created_at and would push the
  // (older) subscription + back-catalogue rows outside the 100-row scoring
  // window. Those follow-provenance candidates are exactly what fills the
  // reserved floors and the "subscriptions through the pool" guarantee, so
  // they must score first: subscription → back-catalogue → delighter, newest
  // first within each. The LIMIT then bites on the over-supplied delighter
  // bucket (which only needs to fill a floor of 2), never on the follows.
  const pending = db.prepare(`
    SELECT c.candidate_id, c.external_id, c.title, c.url, c.thumbnail_url,
           c.published_at, c.source_type, c.interest_id, c.person_id,
           c.channel, c.duration_secs,
           i.label AS interest_label,
           ui.expertise AS interest_expertise,
           p.display_name AS person_name
    FROM candidate_pool c
    LEFT JOIN interests i ON i.id = c.interest_id
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    LEFT JOIN people p ON p.person_id = c.person_id
    WHERE c.user_id = ? AND c.status = 'pending'
    ORDER BY
      CASE c.source_type
        WHEN 'subscription' THEN 0
        WHEN 'person_backcatalog' THEN 1
        ELSE 2
      END ASC,
      c.created_at DESC
    LIMIT 100
  `).all(userId) as CandidateRow[];

  if (pending.length === 0) return;

  const interestSummary = userInterests
    .map((t) => `"${t.label}" (${t.expertise})`)
    .join(', ');

  // Read once per discovery run — the active set doesn't change inside a
  // scoring pass, and Gemma sees the same statements on every batch so a
  // user's pattern shows up consistently across the day's surfaced items.
  const affinityStatements = lookupActiveAffinityStatements(userId);

  const BATCH = 10;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);

    const items: ScoringItem[] = batch.map((c, idx) => ({
      index: idx + 1,
      candidateId: c.candidate_id,
      title: c.title ?? '(no title)',
      channel: c.channel ?? '',
      durationSecs: c.duration_secs,
      publishedAt: c.published_at,
      interestLabel: c.interest_label,
      expertise: c.interest_expertise,
      sourceType: c.source_type,
      personId: c.person_id,
      personName: c.person_name,
    }));

    const prompt = buildScoringPrompt(items, interestSummary, affinityStatements);

    let raw: string;
    try {
      // Three-axis scoring + sensitivity tag + specific why-text runs ~200
      // tokens per video. Batch of 10 needs headroom. Low temperature so the
      // same video gets the same score across runs — score-prompt iteration
      // shouldn't be fighting model variance.
      raw = await ollamaGenerate(prompt, undefined, undefined, {
        num_predict: 3000,
        temperature: 0.2,
      });
    } catch (err) {
      logger.warn({ err, userId, batchStart: i }, 'Discovery: scoring Gemma call failed');
      continue;
    }

    const scores = parseScoringVerdict(raw);
    if (!scores) {
      logger.warn({ userId, raw: raw.slice(0, 200) }, 'Discovery: could not parse scoring response');
      continue;
    }

    const now = new Date().toISOString();
    for (const entry of scores) {
      const item = items[entry.index - 1];
      if (!item) continue;

      const rawConnection = clampScore(entry.connection);
      const quality = clampScore(entry.quality);
      if (rawConnection === null || quality === null) continue;

      const sensitivity: TimeSensitivity = item.sourceType === 'person_backcatalog'
        // Back-catalog: the upload date is years old by definition, but the
        // user's *discovery* of it is what's fresh. Forcing evergreen
        // sidesteps the news/standard decay curves (which would crush a
        // 5-year-old video to a 0.05–0.4× multiplier) and lets back-catalog
        // candidates compete at face value on connection × quality.
        ? 'evergreen'
        : overrideTimeSensitivity(item.title, normalizeSensitivity(entry.time_sensitivity));

      // Trust weight (issue #58, brief §9a Layer 3): for person-sourced
      // candidates only, multiply Gemma's connection score by the user's
      // per-person trust weight (0.5–1.5, default 1.0). Interest-search
      // candidates have person_id IS NULL and stay unchanged. Gating on
      // person_id rather than source_type makes this forward-compatible
      // with any future person-sourced source_type.
      const trustWeight = item.personId !== null
        ? lookupTrustWeight(userId, item.personId)
        : 1.0;
      const connection = rawConnection * trustWeight;

      // gemma_score retained as connection × quality / 10 (0–10 range) so
      // older code paths (e.g. guardCandidates' top-N) still work.
      const combined = (connection * quality) / 10;

      db.prepare(`
        UPDATE candidate_pool
        SET connection_score = ?, quality_score = ?, gemma_score = ?,
            time_sensitivity = ?, why_text = ?, status = 'scored', scored_at = ?
        WHERE candidate_id = ?
      `).run(connection, quality, combined, sensitivity, normalizeScoringWhy(item.title, entry.why), now, item.candidateId);
    }
  }
}
