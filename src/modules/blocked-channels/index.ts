// Blocked channels: a household-wide parent rule on a YouTube channel. A
// blocked channel's videos never reach any kid's slate, and a kid's request
// from it is rejected before the guard runs. Adults are unaffected.
//
// This module owns the `blocked_channels` table and nothing else — it is a
// leaf, so discovery, people and requests can all read it without a cycle.
// The effects of a block on the Candidate pool live with discovery
// (`blockChannel` there), and on requests with the requests module.
//
// Matching is by channel id. A row with no channel id (older candidates the
// 045 backfill couldn't place, or a download whose metadata lacked one) falls
// back to matching the channel's display name as recorded at block time.
import { db } from '../../db/client';

export { BLOCKED_CHANNEL_REASON, parseChannelRef, isChannelId, type ChannelRef } from './util';

export interface BlockedChannel {
  channelId: string;
  displayName: string;
  reason: string | null;
  blockedBy: string;
  blockedAt: string;
}

interface Row {
  channel_id: string;
  display_name: string;
  reason: string | null;
  blocked_by: string;
  blocked_at: string;
}

function toBlocked(r: Row): BlockedChannel {
  return {
    channelId: r.channel_id,
    displayName: r.display_name,
    reason: r.reason,
    blockedBy: r.blocked_by,
    blockedAt: r.blocked_at,
  };
}

export function listBlockedChannels(): BlockedChannel[] {
  return (db.prepare(
    'SELECT channel_id, display_name, reason, blocked_by, blocked_at FROM blocked_channels ORDER BY blocked_at, channel_id',
  ).all() as Row[]).map(toBlocked);
}

export function getBlockedChannel(channelId: string): BlockedChannel | null {
  const row = db.prepare(
    'SELECT channel_id, display_name, reason, blocked_by, blocked_at FROM blocked_channels WHERE channel_id = ?',
  ).get(channelId) as Row | undefined;
  return row ? toBlocked(row) : null;
}

export interface BlockInput {
  channelId: string;
  displayName: string;
  reason: string | null;
  blockedBy: string;
  now?: Date;
}

// Record a block. Idempotent: an existing block is kept as it was (first
// blocker, first reason) and `created` is false.
export function recordChannelBlock(input: BlockInput): { created: boolean } {
  const res = db.prepare(`
    INSERT OR IGNORE INTO blocked_channels (channel_id, display_name, reason, blocked_by, blocked_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.channelId,
    input.displayName,
    input.reason,
    input.blockedBy,
    (input.now ?? new Date()).toISOString(),
  );
  return { created: res.changes > 0 };
}

export function unblockChannel(channelId: string): boolean {
  return db.prepare('DELETE FROM blocked_channels WHERE channel_id = ?').run(channelId).changes > 0;
}

// One point-in-time read for loops (intake), so each candidate isn't a query.
export interface BlockedChannelSet {
  size: number;
  has: (channelId: string | null | undefined, displayName?: string | null) => boolean;
}

export function loadBlockedChannels(): BlockedChannelSet {
  const rows = listBlockedChannels();
  const ids = new Set(rows.map((r) => r.channelId));
  const names = new Set(rows.map((r) => r.displayName));
  return {
    size: rows.length,
    has: (channelId, displayName) => {
      if (channelId) return ids.has(channelId);
      return !!displayName && names.has(displayName);
    },
  };
}

export function isChannelBlocked(channelId: string | null | undefined, displayName?: string | null): boolean {
  if (channelId) {
    return db.prepare('SELECT 1 FROM blocked_channels WHERE channel_id = ?').get(channelId) !== undefined;
  }
  if (!displayName) return false;
  return db.prepare('SELECT 1 FROM blocked_channels WHERE display_name = ?').get(displayName) !== undefined;
}

// SQL fragment: true when the row's channel is NOT blocked. `idExpr` and
// `nameExpr` are column expressions from the caller's query (e.g. `c.channel_id`,
// `c.channel`) — code, never input. Same id-first, name-fallback rule as above.
export function notBlockedChannelSql(idExpr: string, nameExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM blocked_channels bc
     WHERE (${idExpr} IS NOT NULL AND bc.channel_id = ${idExpr})
        OR (${idExpr} IS NULL AND ${nameExpr} IS NOT NULL AND bc.display_name = ${nameExpr})
  )`;
}

// SQL fragment: true when the row's channel matches the given bound
// parameters (`@channelId`, `@displayName`), with the same fallback.
export function matchesChannelSql(idExpr: string, nameExpr: string): string {
  return `((${idExpr} IS NOT NULL AND ${idExpr} = @channelId)
        OR (${idExpr} IS NULL AND ${nameExpr} = @displayName))`;
}
