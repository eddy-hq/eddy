#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * npm run discovery:preview [userId]
 *
 * Dry-run of surfacing logic. Shows the two-axis score table for every
 * scored candidate in the pool — connection × quality × freshness × rank
 * weight — and which slot (regular / stretch / —) they would fill today.
 * Candidates that fail the connection or quality floor are still listed so
 * you can see what was rejected and why. Does NOT write surfaced_date.
 */
import 'dotenv/config';
import { runMigrations } from '../db/migrate';
import { seedUsers } from '../db/seed';
import { db } from '../db/client';
import {
  freshnessMultiplier,
  rankWeight,
  MIN_CONNECTION_SCORE,
  MIN_QUALITY_SCORE,
} from '../modules/discovery/index';

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

function failureReason(c: Candidate): string | null {
  const conn = c.connection_score ?? 0;
  const qual = c.quality_score ?? 0;
  if (conn < MIN_CONNECTION_SCORE && qual < MIN_QUALITY_SCORE) return 'low both';
  if (conn < MIN_CONNECTION_SCORE) return 'low conn';
  if (qual < MIN_QUALITY_SCORE) return 'low qual';
  return null;
}

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
  const stretchQuota = Math.min(remaining, Math.max(1, Math.floor(cap * 0.2)));
  const regularQuota = remaining - stretchQuota;

  console.log(`  Cap ${cap} · already surfaced today ${alreadySurfaced} · remaining ${remaining} (regular ${regularQuota} + stretch ${stretchQuota})`);
  console.log(`  Floors: connection ≥ ${MIN_CONNECTION_SCORE} · quality ≥ ${MIN_QUALITY_SCORE}`);

  const guardClause = isKid
    ? "AND (c.guard_verdict = 'clear_yes' OR c.guard_verdict IS NULL)"
    : '';

  const rows = db.prepare(`
    SELECT c.candidate_id, c.title, c.channel, c.published_at,
           c.connection_score, c.quality_score, c.why_text, c.guard_verdict,
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

  const ranked = rows
    .map((r) => ({
      row: r,
      fresh: freshnessMultiplier(r.published_at),
      rWeight: rankWeight(r.rank),
      weighted: (r.connection_score ?? 0)
        * (r.quality_score ?? 0)
        * freshnessMultiplier(r.published_at)
        * rankWeight(r.rank),
      reject: failureReason(r),
    }))
    .sort((a, b) => b.weighted - a.weighted);

  const eligible = ranked.filter((r) => r.reject === null);

  // Replicate surfaceForToday allocation without writing.
  const slot = new Map<string, 'regular' | 'stretch'>();
  for (const r of eligible) {
    if (slot.size >= regularQuota) break;
    slot.set(r.row.candidate_id, 'regular');
  }
  const stretchPool = eligible.filter((r) => !slot.has(r.row.candidate_id) && r.row.rank > 3);
  for (const s of stretchPool) {
    if (slot.size >= regularQuota + stretchQuota) break;
    slot.set(s.row.candidate_id, 'stretch');
  }
  if (slot.size < remaining) {
    for (const r of eligible) {
      if (slot.has(r.row.candidate_id)) continue;
      slot.set(r.row.candidate_id, 'regular');
      if (slot.size >= remaining) break;
    }
  }

  const headers = ['conn', 'qual', 'fresh', 'rank', 'weighted', 'slot', 'source', 'age', 'interest', 'title'];
  console.log(`\n  ${headers[0]?.padStart(4)}  ${headers[1]?.padStart(4)}  ${headers[2]?.padStart(5)}  ${headers[3]?.padStart(4)}  ${headers[4]?.padStart(8)}  ${headers[5]?.padEnd(9)}  ${headers[6]?.padEnd(12)}  ${headers[7]?.padStart(4)}  ${headers[8]?.padEnd(16)}  ${headers[9]}`);

  // Compress source_type for column width — full values are like
  // 'interest_search' / 'person_backcatalog' which won't fit cleanly.
  const sourceLabel = (s: string): string => {
    if (s === 'person_backcatalog') return 'backcat';
    if (s === 'interest_search') return 'interest';
    if (s === 'person_recommendation') return 'rec';
    if (s === 'person_output') return 'follow';
    return s;
  };

  for (const r of ranked) {
    const conn = (r.row.connection_score ?? 0).toFixed(1).padStart(4);
    const qual = (r.row.quality_score ?? 0).toFixed(1).padStart(4);
    const fresh = `×${r.fresh.toFixed(1)}`.padStart(5);
    const rank = (r.row.rank === 999 ? '—' : String(r.row.rank)).padStart(4);
    const weighted = r.weighted.toFixed(1).padStart(8);
    const slotRaw = r.reject !== null ? r.reject : (slot.get(r.row.candidate_id) ?? '—');
    const slotLabel = slotRaw.padEnd(9);
    const source = sourceLabel(r.row.source_type).padEnd(12);
    const age = ageLabel(r.row.published_at).padStart(4);
    const interest = trunc(r.row.interest_label ?? '—', 16).padEnd(16);
    const title = trunc(r.row.title ?? '(no title)', 70);
    console.log(`  ${conn}  ${qual}  ${fresh}  ${rank}  ${weighted}  ${slotLabel}  ${source}  ${age}  ${interest}  ${title}`);
    if (r.row.why_text) console.log(`        why → ${trunc(r.row.why_text, 110)}`);
  }

  const picks = ranked.filter((r) => slot.has(r.row.candidate_id)).length;
  const rejected = ranked.filter((r) => r.reject !== null).length;
  console.log(`\n  Eligible: ${eligible.length} · rejected by floor: ${rejected} · would surface: ${picks} of ${remaining} slot(s).`);
}

process.exit(0);
