#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run discovery:preview [userId]
 *
 * Dry-run of surfacing logic. Pipes the candidate pool through the same
 * `rank()` the production surfacer uses and prints a per-row table with
 * the disposition each item would receive. Does NOT write surfaced_date.
 */
import 'dotenv/config';
import { runMigrations } from '../db/migrate';
import { seedUsers } from '../db/seed';
import { db } from '../db/client';
import {
  rank,
  MIN_CONNECTION_SCORE,
  MIN_QUALITY_SCORE,
  type RankerCandidate,
} from '../modules/discovery/ranker';

runMigrations();
seedUsers();

const targetArg = process.argv[2] ?? null;

interface UserRow { user_id: string; role: string; age_gate: number; display_name: string; }

const users = (targetArg
  ? db.prepare(
      'SELECT user_id, role, age_gate, display_name FROM users WHERE user_id = ? OR lower(display_name) = lower(?)'
    ).all(targetArg, targetArg)
  : db.prepare("SELECT user_id, role, age_gate, display_name FROM users WHERE role IN ('kid','parent')").all()
) as UserRow[];

if (users.length === 0) {
  console.error('No users found', targetArg ? `for userId ${targetArg}` : '');
  process.exit(1);
}

interface Candidate {
  candidate_id: string;
  title: string | null;
  channel: string | null;
  published_at: string | null;
  connection_score: number | null;
  quality_score: number | null;
  time_sensitivity: string | null;
  why_text: string | null;
  guard_verdict: string | null;
  interest_id: string | null;
  interest_label: string | null;
  source_type: string;
  rank: number;
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function ageLabel(iso: string | null): string {
  if (!iso) return '?';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return '<1d';
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

const SLOT_LABEL: Record<string, string> = {
  regular: 'regular',
  stretch: 'stretch',
  low_conn: 'low conn',
  low_qual: 'low qual',
  low_both: 'low both',
  low_weight: 'low weight',
  cut_interest_cap: 'cut cap',
  cut_dedup: 'cut dedup',
  cut_stretch_rank: 'cut rank',
};

for (const user of users) {
  console.log(`\n── ${user.display_name} (${user.role}) ──────────────────────`);

  const isKid = user.role === 'kid';
  const cap = isKid ? 5 : 15;

  const today = new Date().toISOString().slice(0, 10);
  const alreadySurfaced = (db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_pool
    WHERE user_id = ? AND surfaced_date = ?
  `).get(user.user_id, today) as { n: number }).n;

  const remaining = Math.max(0, cap - alreadySurfaced);
  // Dry-run: when the user is already at cap, fall back to the full cap
  // so the preview still shows what would have been picked. Quotas must
  // be computed from the same value passed to rank() — otherwise the
  // header lies about the split (e.g. remaining=2 prints 0+2 when the
  // ranker is actually doing 1+1).
  const rankCap = remaining || cap;
  const stretchQuota = Math.max(1, Math.floor(rankCap * 0.2));
  const regularQuota = Math.max(0, rankCap - stretchQuota);

  console.log(`  Cap ${cap} · already surfaced today ${alreadySurfaced} · remaining ${remaining} (regular ${regularQuota} + stretch ${stretchQuota})`);
  console.log(`  Floors: connection ≥ ${MIN_CONNECTION_SCORE} · quality ≥ ${MIN_QUALITY_SCORE}`);

  const guardClause = isKid
    ? "AND (c.guard_verdict = 'clear_yes' OR c.guard_verdict IS NULL)"
    : '';

  const rows = db.prepare(`
    SELECT c.candidate_id, c.title, c.channel, c.published_at,
           c.connection_score, c.quality_score, c.time_sensitivity,
           c.why_text, c.guard_verdict,
           c.interest_id, c.source_type, i.label AS interest_label,
           COALESCE(ui.rank, 999) AS rank
    FROM candidate_pool c
    LEFT JOIN user_interests ui
      ON ui.user_id = c.user_id AND ui.interest_id = c.interest_id
    LEFT JOIN interests i ON i.id = c.interest_id
    WHERE c.user_id = ? AND c.status = 'scored' ${guardClause}
      AND c.surfaced_date IS NULL
  `).all(user.user_id) as Candidate[];

  if (rows.length === 0) {
    console.log('  No scored candidates in the pool.');
    continue;
  }

  const candidates: RankerCandidate[] = rows.map((r) => ({
    candidateId: r.candidate_id,
    title: r.title,
    publishedAt: r.published_at,
    connectionScore: r.connection_score,
    qualityScore: r.quality_score,
    timeSensitivity: r.time_sensitivity,
    interestId: r.interest_id,
    rank: r.rank,
  }));

  const verdicts = rank(
    candidates,
    { now: new Date(), isKid, prefilledTitles: [], prefilledInterestCounts: new Map() },
    { cap: rankCap },
  );

  const rowById = new Map(rows.map((r) => [r.candidate_id, r]));

  // Compress source_type for column width.
  const sourceLabel = (s: string): string => {
    if (s === 'person_backcatalog') return 'backcat';
    if (s === 'interest_search') return 'interest';
    if (s === 'person_recommendation') return 'rec';
    if (s === 'person_output') return 'follow';
    return s;
  };

  const headers = ['conn', 'qual', 'fresh', 'rank', 'weighted', 'slot', 'source', 'age', 'interest', 'title'];
  console.log(`\n  ${headers[0]?.padStart(4)}  ${headers[1]?.padStart(4)}  ${headers[2]?.padStart(5)}  ${headers[3]?.padStart(4)}  ${headers[4]?.padStart(8)}  ${headers[5]?.padEnd(10)}  ${headers[6]?.padEnd(12)}  ${headers[7]?.padStart(4)}  ${headers[8]?.padEnd(16)}  ${headers[9]}`);

  for (const v of verdicts) {
    const row = rowById.get(v.candidate.candidateId);
    if (!row) continue;
    const conn = (row.connection_score ?? 0).toFixed(1).padStart(4);
    const qual = (row.quality_score ?? 0).toFixed(1).padStart(4);
    const fresh = `×${v.fresh.toFixed(1)}`.padStart(5);
    const rankStr = (row.rank === 999 ? '—' : String(row.rank)).padStart(4);
    const weighted = v.weighted.toFixed(1).padStart(8);
    const slotLabel = (SLOT_LABEL[v.disposition] ?? v.disposition).padEnd(10);
    const source = sourceLabel(row.source_type).padEnd(12);
    const age = ageLabel(row.published_at).padStart(4);
    const interest = trunc(row.interest_label ?? '—', 16).padEnd(16);
    const title = trunc(row.title ?? '(no title)', 70);
    console.log(`  ${conn}  ${qual}  ${fresh}  ${rankStr}  ${weighted}  ${slotLabel}  ${source}  ${age}  ${interest}  ${title}`);
    if (row.why_text) console.log(`        why → ${trunc(row.why_text, 110)}`);
  }

  const picks = verdicts.filter((v) => v.disposition === 'regular' || v.disposition === 'stretch').length;
  const rejected = verdicts.filter((v) => v.disposition.startsWith('low_')).length;
  const cuts = verdicts.filter((v) => v.disposition.startsWith('cut_')).length;
  console.log(`\n  Eligible: ${verdicts.length - rejected} · rejected by floor: ${rejected} · cut: ${cuts} · would surface: ${picks} of ${rankCap} slot(s).`);
}

process.exit(0);
