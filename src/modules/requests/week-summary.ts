// Tier 4 week summary — Gemma-generated editorial line (issue #143).
//
// This is a new Gemma call site, beyond the two already in production (guard
// triage, discovery scoring). It produces the one-line editorial summary that
// sits on each Tier 4 week-row — the prototype tone:
//
//   "38 items · mostly Minecraft, a run of Steve Mould"
//
// Cadence (acceptance is explicit): summaries are NOT generated on the feed
// path. They are cached in `tier4_week_summaries` keyed on (user_id,
// week_start). The feed handler reads the cache only — it serves a stored
// `summary` when the cached `item_count` still matches the week's current
// count, otherwise null. Regeneration happens out-of-band via the admin
// trigger (`POST /requests/admin/week-summaries/regenerate`), which re-runs
// Gemma for every stale week (count changed, or no cached row).
//
// Privacy: NO user identifier and NO real name ever enters the prompt. Only
// video titles, channels, provenance kinds and the count go to Gemma. The
// output is additionally guarded against any household display name leaking
// back out (see guardSummary) before it is stored — a defence-in-depth mirror
// of the Boy1/Boy2 convention: real names live in the DB, never in cached text.

import { db } from '../../db/client';
import { logger } from '../../logger';
import { ollamaGenerate } from '../../ollama';
import { config } from '../../config';
import type { FeedKind, TierInputRow, Tier4Week } from './feed-tiers';
import { sourceToKind, isoWeekRange, ageInDays } from './feed-tiers';

export const WEEK_SUMMARY_PROMPT_VERSION = 'week-summary-v1';

// Output guard constants (issue #143 acceptance).
const MAX_SUMMARY_LEN = 80;
// Cap how many items are listed in the prompt — a busy week can hold hundreds
// of rows, but the editorial line only needs the texture (dominant channels,
// notable runs), not an exhaustive manifest. Most-recent-first ordering is
// preserved from the feed query so the prompt leans on recent activity.
const MAX_PROMPT_ITEMS = 40;

/** One item of a week, as fed to Gemma. No user id, no real name. */
export interface WeekSummaryItem {
  title: string;
  channel: string | null;
  kind: FeedKind;
}

/** A week needing (re)generation: its key, current count, and items. */
export interface StaleWeek {
  weekStart: string;
  count: number;
  items: WeekSummaryItem[];
}

const KIND_LABEL: Record<FeedKind, string> = {
  req: 'you asked for',
  follow: 'from a follow',
  pick: 'a pick',
};

// Replace any household real name found in a title/channel string with a
// neutral placeholder BEFORE the text reaches Gemma. A YouTube title or channel
// can legitimately contain a household member's name (a video about/by them),
// and the acceptance requires kids be Boy1/Boy2 in any text Gemma sees — the
// output guard is too late on its own, so we scrub the input too. Word-boundary
// matched, case-insensitive, preserving everything else.
export function redactNames(text: string, displayNames: string[]): string {
  let out = text;
  for (const name of displayNames) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '[name]');
  }
  return out;
}

// Build the generation prompt. Inputs are the week's item count plus a bounded
// list of (title, channel, provenance) lines, with any household real name in a
// title/channel already redacted (see redactNames) — no user id and no real
// name ever reaches Gemma. The model is asked for exactly the "{count} items ·
// {prose}" shape so the shape guard can verify it.
export function buildWeekSummaryPrompt(
  count: number,
  items: WeekSummaryItem[],
  displayNames: string[] = [],
): string {
  const lines = items.slice(0, MAX_PROMPT_ITEMS).map((item, i) => {
    const title = redactNames(item.title, displayNames);
    const channel = item.channel ? redactNames(item.channel, displayNames) : 'unknown channel';
    return `${i + 1}. "${title}" — ${channel} (${KIND_LABEL[item.kind]})`;
  }).join('\n');

  return `Write a single editorial line summarising a week of a person's watch history, in the warm, plain voice of a personal media companion.

There were ${count} items this week. A sample of them (title — channel — how it arrived):
${lines}

The line names the texture of the week: the dominant channels or topics, and any notable run of one thing. Think "the shape of the week", not a list.

Return ONLY the line, no quotes, no preamble, in exactly this shape:
${count} items · {your prose}

Rules:
- Start with "${count} items · " exactly.
- UK English.
- At most ${MAX_SUMMARY_LEN} characters total, single line.
- No trailing full stop or other end punctuation.
- Use only the channels and topics shown above — never invent names, and never name a person.

Example tone (do not copy the content): "${count} items · mostly Minecraft, a run of Steve Mould"`;
}

// Lowercased set of household display names, read once per regeneration pass.
// Real names live only in the DB (surfaced as Boy1/Boy2 in any text we keep);
// this is the output guard that rejects a summary that leaked one back out.
function householdDisplayNames(): string[] {
  const rows = db.prepare('SELECT display_name FROM users').all() as Array<{ display_name: string | null }>;
  return rows
    .map((r) => r.display_name?.trim().toLowerCase())
    .filter((n): n is string => !!n && n.length > 0);
}

// Word-boundary test so a name that is a substring of an ordinary word (e.g. a
// short display name inside a longer token) doesn't trigger a false reject,
// while a standalone occurrence does.
function containsName(haystackLower: string, nameLower: string): boolean {
  const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystackLower);
}

// Why a raw output was rejected. Used only as a non-PII log reason — the
// rejected text itself (which may contain the very real name the guard
// refused) is never logged, per the no-PII-in-logs rule.
export type GuardFailureReason = 'empty' | 'shape' | 'length' | 'pii';

export interface GuardResult {
  /** The storable summary, or null if any check failed. */
  summary: string | null;
  /** Set only when summary is null — a coarse, PII-free reason code. */
  reason: GuardFailureReason | null;
}

// Guard a raw Gemma output into a storable summary, reporting a PII-free reason
// code on failure. All failure modes (empty, wrong shape, too long, contains a
// real name) collapse to a null summary so the feed serves the front-end's
// templated fallback rather than a bad string.
export function guardSummaryDetailed(
  raw: string,
  count: number,
  displayNames: string[],
): GuardResult {
  if (!raw) return { summary: null, reason: 'empty' };

  // Collapse to a single line and strip surrounding quotes the model sometimes
  // wraps the line in, then trim trailing end-punctuation (acceptance: no
  // trailing punctuation).
  let line = raw.replace(/\r?\n+/g, ' ').trim();
  line = line.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '').trim();
  line = line.replace(/[.!?;,…]+$/, '').trim();

  if (!line) return { summary: null, reason: 'empty' };

  // Shape: must be "{count} items · {prose}" with non-empty prose. The middot
  // separator and the exact count anchor the line; reject anything else.
  const prefix = `${count} items · `;
  if (!line.startsWith(prefix)) return { summary: null, reason: 'shape' };
  const prose = line.slice(prefix.length).trim();
  if (!prose) return { summary: null, reason: 'shape' };

  // Length: whole line ≤ 80 chars (after trimming).
  if (line.length > MAX_SUMMARY_LEN) return { summary: null, reason: 'length' };

  // PII: reject any household real name, case-insensitive, on a word boundary.
  const lower = line.toLowerCase();
  for (const name of displayNames) {
    if (containsName(lower, name)) return { summary: null, reason: 'pii' };
  }

  return { summary: line, reason: null };
}

// Thin wrapper returning just the storable summary (or null). Keeps the simple
// shape for callers/tests that don't need the failure reason.
export function guardSummary(
  raw: string,
  count: number,
  displayNames: string[],
): string | null {
  return guardSummaryDetailed(raw, count, displayNames).summary;
}

// Generate + guard one week's summary. Returns the guarded string, or null on
// Gemma being unreachable, a parse/empty response, or any guard failure. Never
// throws — the caller stores whatever comes back (including null).
export async function generateWeekSummary(week: StaleWeek): Promise<string | null> {
  const displayNames = householdDisplayNames();
  const prompt = buildWeekSummaryPrompt(week.count, week.items, displayNames);

  let raw: string;
  try {
    // One short line of prose: low temperature for stable wording across runs,
    // small num_predict — the line is capped at 80 chars. Summary model
    // override falls back to the guard model.
    raw = await ollamaGenerate(prompt, config.OLLAMA_SUMMARY_MODEL, undefined, {
      num_predict: 120,
      temperature: 0.3,
    });
  } catch (err) {
    logger.warn({ err, weekStart: week.weekStart }, 'Week summary: Gemma call failed — storing null');
    return null;
  }

  const { summary, reason } = guardSummaryDetailed(raw, week.count, displayNames);
  if (summary === null) {
    // Log only the coarse reason code — never the rejected text, which may
    // contain the very real name the PII guard refused (no-PII-in-logs rule).
    logger.info({ weekStart: week.weekStart, reason }, 'Week summary: output failed guard — storing null');
  }
  return summary;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheRow {
  week_start: string;
  item_count: number;
  summary: string | null;
}

// Read all cached week summaries for a user into a map keyed on week_start.
// Used by the feed path (read-only) and the regeneration trigger (to detect
// staleness). DB access lives here in the owning module, not in a shared helper.
export function readWeekSummaryCache(userId: string): Map<string, CacheRow> {
  const rows = db.prepare(
    'SELECT week_start, item_count, summary FROM tier4_week_summaries WHERE user_id = ?'
  ).all(userId) as CacheRow[];
  const map = new Map<string, CacheRow>();
  for (const row of rows) map.set(row.week_start, row);
  return map;
}

// Resolve a week's cached summary for serving on the feed: returns the stored
// string only when the cached item_count matches the week's current count
// (a fresh cache hit). A mismatch or missing row reads as null — the week is
// stale and will be filled by the next regeneration pass. Never calls Ollama.
export function cachedSummaryForWeek(
  cache: Map<string, CacheRow>,
  weekStart: string,
  currentCount: number,
): string | null {
  const row = cache.get(weekStart);
  if (!row) return null;
  if (row.item_count !== currentCount) return null;
  return row.summary;
}

// Populate `summary` on each built Tier 4 week from the cache, reading only —
// no Ollama, no DB writes. A week whose stored item_count still matches its
// current count gets the cached string (which may itself be null after a guard
// failure); any other week stays null. The feed handler calls this after
// buildTierSummaries so the request path is purely a cache lookup.
export function applyCachedSummaries(weeks: Tier4Week[], cache: Map<string, CacheRow>): Tier4Week[] {
  return weeks.map((week) => ({
    ...week,
    summary: cachedSummaryForWeek(cache, week.rangeStart, week.count),
  }));
}

// Upsert a generated summary into the cache. Stores the count it was generated
// against so a later count change marks it stale.
export function writeWeekSummary(
  userId: string,
  weekStart: string,
  itemCount: number,
  summary: string | null,
): void {
  db.prepare(`
    INSERT INTO tier4_week_summaries
      (user_id, week_start, item_count, summary, prompt_version, generated_at)
    VALUES
      (@user_id, @week_start, @item_count, @summary, @prompt_version, @generated_at)
    ON CONFLICT(user_id, week_start) DO UPDATE SET
      item_count     = excluded.item_count,
      summary        = excluded.summary,
      prompt_version = excluded.prompt_version,
      generated_at   = excluded.generated_at
  `).run({
    user_id: userId,
    week_start: weekStart,
    item_count: itemCount,
    summary,
    prompt_version: WEEK_SUMMARY_PROMPT_VERSION,
    generated_at: new Date().toISOString(),
  });
}

// ── Staleness ────────────────────────────────────────────────────────────────

const TIER4_MIN_AGE_DAYS = 30;

// Group a user's Tier 4 rows (age ≥ 30 days) into per-week buckets, mirroring
// buildTierSummaries' Tier 4 logic. `count` counts EVERY row in the week
// (including title-less rows) so it matches the feed's Tier 4 `count` exactly —
// that is the value the feed compares the cache against. The prompt item list,
// by contrast, carries only titled rows: a null title gives Gemma nothing
// useful, and an all-title-less week still gets a count-only summary attempt.
// Pure given `rows` and `todayStr`.
export function groupTier4Weeks(rows: TierInputRow[], todayStr: string): StaleWeek[] {
  const counts = new Map<string, number>();
  const items = new Map<string, WeekSummaryItem[]>();
  for (const row of rows) {
    if (ageInDays(row.day, todayStr) < TIER4_MIN_AGE_DAYS) continue;
    const { rangeStart } = isoWeekRange(row.day);
    counts.set(rangeStart, (counts.get(rangeStart) ?? 0) + 1);
    if (!items.has(rangeStart)) items.set(rangeStart, []);
    if (row.title) {
      items.get(rangeStart)!.push({
        title: row.title,
        channel: row.channel,
        kind: sourceToKind(row.source),
      });
    }
  }

  const weeks: StaleWeek[] = [];
  for (const [weekStart, count] of counts) {
    weeks.push({ weekStart, count, items: items.get(weekStart) ?? [] });
  }
  return weeks;
}

// Of all a user's Tier 4 weeks, return those whose current item count differs
// from the cache (or that have no cached row) — the weeks the regeneration
// trigger re-runs Gemma for by default. Pure given `rows`, `todayStr` and the
// cache.
export function computeStaleWeeks(
  rows: TierInputRow[],
  todayStr: string,
  cache: Map<string, CacheRow>,
): StaleWeek[] {
  return groupTier4Weeks(rows, todayStr).filter((week) => {
    const cached = cache.get(week.weekStart);
    return !cached || cached.item_count !== week.count;
  });
}

// ── Regeneration trigger ──────────────────────────────────────────────────────

// Must match FEED_LIMIT in ./index.ts. The regeneration path has to slice weeks
// from the exact same row set the feed serves — including the same LIMIT — or a
// user over the cap would get a different Tier 4 count for the cutoff week, and
// that cache row would never match in applyCachedSummaries, leaving the week's
// summary permanently null. Declared here (not imported) to avoid a circular
// import with index.ts; the value must track FEED_LIMIT.
const FEED_ROW_LIMIT = 1000;

// Read a user's Tier-input rows the same way the feed handler does (added_at,
// falling back to requested_at, for the rows the feed surfaces). Kept here so
// the regeneration path and the feed path slice weeks from the same source.
// The status / source filter and LIMIT mirror the GET /feed query.
function readTierRows(userId: string): TierInputRow[] {
  const rows = db.prepare(`
    SELECT title, channel, source, requested_at, added_at
    FROM requests
    WHERE user_id = ?
      AND status NOT IN ('dismissed', 'deleted')
      AND NOT (source = 'channel_subscription' AND status IN ('pending', 'downloading'))
    ORDER BY added_at DESC
    LIMIT ?
  `).all(userId, FEED_ROW_LIMIT) as Array<{
    title: string | null; channel: string | null; source: string;
    requested_at: string; added_at: string | null;
  }>;
  return rows.map((row) => ({
    day: (row.added_at ?? row.requested_at).slice(0, 10),
    title: row.title,
    channel: row.channel,
    source: row.source,
  }));
}

export interface RegenerateResult {
  /** Weeks selected for regeneration this run (stale-only, or all when forced). */
  staleCount: number;
  generated: number;
  nulled: number;
  /** Whether every Tier 4 week was regenerated regardless of cache state. */
  forced: boolean;
}

export interface RegenerateOptions {
  /**
   * Regenerate every Tier 4 week regardless of cache state, not just the stale
   * ones. The admin trigger exposes this so a prompt/model/guard change can be
   * re-run across a user's whole history without manually clearing cache rows
   * (issue #143 allows regeneration "on demand via admin endpoint").
   */
  force?: boolean;
  /** Injectable reference date for tests. */
  todayStr?: string;
}

// Regenerate Tier 4 week summaries for a user. By default only stale weeks (item
// count changed, or no cached row) are processed; with `force` every Tier 4
// week is regenerated. Runs Gemma serially (one short call per selected week —
// bounded by how many ≥30-day weeks a user has) and upserts each result,
// storing null when Gemma is unreachable or the output fails guard. This is the
// out-of-band trigger; the feed path never reaches here.
export async function regenerateStaleWeekSummaries(
  userId: string,
  options: RegenerateOptions = {},
): Promise<RegenerateResult> {
  const { force = false, todayStr = new Date().toISOString().slice(0, 10) } = options;
  const cache = readWeekSummaryCache(userId);
  const tierRows = readTierRows(userId);
  const weeks = force
    ? groupTier4Weeks(tierRows, todayStr)
    : computeStaleWeeks(tierRows, todayStr, cache);

  let generated = 0;
  let nulled = 0;
  for (const week of weeks) {
    const summary = await generateWeekSummary(week);
    writeWeekSummary(userId, week.weekStart, week.count, summary);
    if (summary === null) nulled += 1;
    else generated += 1;
  }

  logger.info(
    { userId, selected: weeks.length, generated, nulled, forced: force },
    'Week summaries regenerated',
  );
  return { staleCount: weeks.length, generated, nulled, forced: force };
}
