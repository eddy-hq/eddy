import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate, parseOllamaJson } from '../../ollama';
import { formatAge, formatDuration } from './util';
import { clampScore, normalizeSensitivity, type TimeSensitivity } from './ranker';
import type { UserInterestRow } from './intake';
import { TRUST_DEFAULT } from '../profile-enrichment';

export type { TimeSensitivity };

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

export function buildScoringPrompt(items: ScoringItem[], interestSummary: string): string {
  const videoList = items.map((item) => {
    const channel = item.channel ? item.channel : 'unknown channel';
    const seedTag = item.interestLabel
      ? ` [seeded by interest: "${item.interestLabel}"${item.expertise ? `, ${item.expertise}` : ''}]`
      : '';
    const followTag = item.sourceType === 'person_backcatalog' && item.personName
      ? ` [back-catalog from a person you follow: ${item.personName}]`
      : '';
    return `${item.index}. "${item.title}" — ${channel} | ${formatDuration(item.durationSecs)} | ${formatAge(item.publishedAt)}${seedTag}${followTag}`;
  }).join('\n');

  return `Score YouTube videos for a personal discovery feed. For each video give a connection score, a quality score, a time-sensitivity tag, and a one-sentence reason.

User interests (priority order, expertise): ${interestSummary}

Videos (title — channel | length | age [seeded by interest] [back-catalog from a person you follow]):
${videoList}

Return ONLY this JSON, one entry per video, no other text:
[{"index":1,"connection":7,"quality":8,"time_sensitivity":"standard","why":"Names the matched interest and a specific aspect of THIS video, max 20 words."}]

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

If a video is tagged "[back-catalog from a person you follow: NAME]", name that person in the "why" — e.g. "NAME has a video on {specific aspect} you haven't seen". The follow does not change the connection or quality scores; the user still has to want this specific video.

The "why" must name the matched interest and something specific about THIS video. Generic phrasing means connection ≤ 3. Do not consider freshness or popularity in the scores — those are applied separately.`;
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

export async function scoreCandidates(userId: string, userInterests: UserInterestRow[]): Promise<void> {
  // JOIN to surface the seeding interest's label + the user's expertise level
  // for that interest, so Gemma can name the connection specifically rather
  // than guess from a list of interests.
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
    ORDER BY c.created_at DESC
    LIMIT 100
  `).all(userId) as CandidateRow[];

  if (pending.length === 0) return;

  const interestSummary = userInterests
    .map((t) => `"${t.label}" (${t.expertise})`)
    .join(', ');

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

    const prompt = buildScoringPrompt(items, interestSummary);

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
      `).run(connection, quality, combined, sensitivity, entry.why ?? null, now, item.candidateId);
    }
  }
}
