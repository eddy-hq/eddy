// Snapshot: freeze the parent's guard decisions into a dataset.
//
// Reads guard_decisions (the label is the latest revision from
// guard_decision_revisions, else the first-pass human_verdict, which is kept
// beside it) with the item inputs the
// candidate guard reads — title and channel from the candidate or request,
// description, tags, category, audience and age restriction from
// video_metadata — and the kid's history with the channel as it stood when the
// parent decided. Runs on a read-only connection: it never writes to the
// production DB and never runs migrations.
//
// The query spans tables owned by several modules (decisions, discovery,
// requests, guard). It is a one-off analytical read of a read-only copy, so it
// lives here rather than as a read helper in each owner.
import type { Database } from 'better-sqlite3';
import type { ChannelHistory } from '../guard/index';
import { isHoldout, type HarnessItem, type HumanLabel } from './util';

export type DropReason = 'subject_missing' | 'no_title' | 'no_metadata';

export interface SnapshotResult {
  items: HarnessItem[];
  decisions: number;
  dropped: Record<DropReason, number>;
}

interface DecisionRow {
  decision_id: string;
  subject_type: 'candidate' | 'request';
  subject_id: string;
  user_id: string;
  youtube_id: string | null;
  age_band: string;
  rubric_version: string;
  source: string;
  guard_verdict: string | null;
  human_verdict: HumanLabel;
  decided_at: string;
  revised_verdict: HumanLabel | null;
  revised_at: string | null;
  subject_found: number;
  title: string | null;
  channel: string | null;
  request_description: string | null;
  item_youtube_id: string | null;
  vm_found: number;
  vm_description: string | null;
  vm_tags_json: string | null;
  vm_category_id: string | null;
  vm_age_restricted: number | null;
  vm_made_for_kids: number | null;
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

// The kid's history with a channel as the live guard would have seen it when
// the parent decided. Mirrors the guard's getChannelHistory — ready / watched
// count as approved, rejected as rejected, case-insensitive channel match,
// parent picks left out — restricted to requests that had reached that state
// strictly before `asOf`, and never counting the decided item itself.
//
// When a request reached its state is the later of decided_at and
// downloaded_at, whichever are set (a parent-allowed pick was downloaded
// before it was decided; a follow upload is downloaded but never decided),
// falling back to requested_at when neither is. Status is today's: a request
// that was ready at `asOf` but has since been deleted no longer counts, as it
// no longer would live.
export function channelHistoryAsOf(
  source: Database,
  params: { userId: string; channel: string; asOf: string; excludeRequestId?: string | null; excludeYoutubeId?: string | null },
): ChannelHistory {
  const row = source.prepare(`
    SELECT
      COUNT(CASE WHEN status IN ('ready', 'watched') THEN 1 END) AS approved,
      COUNT(CASE WHEN status = 'rejected' THEN 1 END)            AS rejected
    FROM requests
    WHERE user_id = @userId AND lower(channel) = lower(@channel)
      AND source != 'parent_pick'
      AND request_id != @excludeRequestId
      AND (youtube_id IS NULL OR youtube_id != @excludeYoutubeId)
      AND COALESCE(max(decided_at, downloaded_at), decided_at, downloaded_at, requested_at) < @asOf
  `).get({
    userId: params.userId,
    channel: params.channel,
    asOf: params.asOf,
    // Empty strings never match a real id.
    excludeRequestId: params.excludeRequestId ?? '',
    excludeYoutubeId: params.excludeYoutubeId ?? '',
  }) as { approved: number; rejected: number } | undefined;
  return { approved: row?.approved ?? 0, rejected: row?.rejected ?? 0 };
}

// A source DB from before migration 048 has no revisions table: every label
// is then its first pass.
function hasRevisions(source: Database): boolean {
  return source.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guard_decision_revisions'`,
  ).get() !== undefined;
}

function selectDecisions(source: Database): DecisionRow[] {
  // The latest revision (#223), when the parent has changed the decision.
  const revisions = hasRevisions(source);
  const latest = (col: string) => revisions
    ? `(SELECT rv.${col} FROM guard_decision_revisions rv
         WHERE rv.decision_id = d.decision_id AND rv.human_verdict IN ('clear_yes', 'clear_no')
         ORDER BY rv.revised_at DESC, rv.rowid DESC LIMIT 1)`
    : 'NULL';
  return source.prepare(`
    SELECT d.decision_id, d.subject_type, d.subject_id, d.user_id, d.youtube_id, d.age_band,
           d.rubric_version, d.source, d.guard_verdict, d.human_verdict, d.decided_at,
           ${latest('human_verdict')}                               AS revised_verdict,
           ${latest('revised_at')}                                  AS revised_at,
           (cp.candidate_id IS NOT NULL OR r.request_id IS NOT NULL) AS subject_found,
           COALESCE(cp.title, r.title)                              AS title,
           COALESCE(cp.channel, r.channel)                          AS channel,
           r.description                                            AS request_description,
           COALESCE(d.youtube_id, cp.external_id, r.youtube_id)     AS item_youtube_id,
           (vm.youtube_id IS NOT NULL)                              AS vm_found,
           vm.description AS vm_description, vm.tags_json AS vm_tags_json,
           vm.category_id AS vm_category_id, vm.age_restricted AS vm_age_restricted,
           vm.made_for_kids AS vm_made_for_kids
    FROM guard_decisions d
    LEFT JOIN candidate_pool cp ON d.subject_type = 'candidate' AND cp.candidate_id = d.subject_id
    LEFT JOIN requests r        ON d.subject_type = 'request'   AND r.request_id   = d.subject_id
    LEFT JOIN video_metadata vm ON vm.youtube_id = COALESCE(d.youtube_id, cp.external_id, r.youtube_id)
    WHERE d.human_verdict IN ('clear_yes', 'clear_no')
    ORDER BY d.decided_at ASC, d.decision_id ASC
  `).all() as DecisionRow[];
}

// Build the dataset from a read-only source. Items without what the candidate
// guard needs — the subject row, a title, a video_metadata row — are dropped
// and counted by reason.
export function buildSnapshot(source: Database): SnapshotResult {
  const dropped: Record<DropReason, number> = { subject_missing: 0, no_title: 0, no_metadata: 0 };
  const items: HarnessItem[] = [];
  const rows = selectDecisions(source);

  for (const row of rows) {
    if (!row.subject_found) { dropped.subject_missing += 1; continue; }
    const title = row.title?.trim() ?? '';
    if (!title) { dropped.no_title += 1; continue; }
    if (!row.vm_found) { dropped.no_metadata += 1; continue; }

    const channel = row.channel?.trim() || null;
    const channelHistory = channel
      ? channelHistoryAsOf(source, {
        userId: row.user_id,
        channel,
        asOf: row.decided_at,
        excludeRequestId: row.subject_type === 'request' ? row.subject_id : null,
        excludeYoutubeId: row.item_youtube_id,
      })
      : null;

    items.push({
      itemId: row.decision_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      userId: row.user_id,
      // The latest revision wins; the first pass is kept beside it.
      label: row.revised_verdict ?? row.human_verdict,
      firstPassLabel: row.human_verdict,
      revisedAt: row.revised_at,
      decisionSource: row.source,
      rubricVersion: row.rubric_version,
      guardVerdict: row.guard_verdict,
      decidedAt: row.decided_at,
      holdout: isHoldout(row.decision_id),
      ageBand: row.age_band,
      title,
      channel,
      // The second pass's fallback: the request's own description when the
      // Data API row has none.
      description: row.vm_description ?? row.request_description ?? null,
      tags: parseTags(row.vm_tags_json),
      categoryId: row.vm_category_id,
      madeForKids: row.vm_made_for_kids === null ? null : row.vm_made_for_kids === 1,
      ageRestricted: row.vm_age_restricted === 1,
      channelHistory,
    });
  }

  return { items, decisions: rows.length, dropped };
}

// Counts for the CLI: never content.
export function summariseDataset(items: readonly HarnessItem[]): {
  total: number;
  holdout: number;
  // Items whose label is a revision rather than the first pass.
  revised: number;
  byLabel: Record<string, number>;
  bySubjectType: Record<string, number>;
} {
  const byLabel: Record<string, number> = {};
  const bySubjectType: Record<string, number> = {};
  let holdout = 0;
  let revised = 0;
  for (const item of items) {
    byLabel[item.label] = (byLabel[item.label] ?? 0) + 1;
    bySubjectType[item.subjectType] = (bySubjectType[item.subjectType] ?? 0) + 1;
    if (item.holdout) holdout += 1;
    if (item.revisedAt) revised += 1;
  }
  return { total: items.length, holdout, revised, byLabel, bySubjectType };
}
