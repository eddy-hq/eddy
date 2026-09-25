// Kid requests from a Blocked channel. The worker asks, once it knows the
// video's channel (after the metadata fetch) and before it downloads or asks
// the guard: a kid's request from a blocked channel is rejected here with a
// kid-facing reason, and the guard never runs on it. An adult's request is
// never affected.
//
// A block can land while a request is in flight, so the M4 asks again before
// anything becomes visible: at the worker's download-complete callback, and
// before the second pass clears a slate pick.
import { db } from '../../db/client';
import { logger } from '../../logger';
import { BLOCKED_CHANNEL_REASON, isChannelBlocked } from '../blocked-channels';
import { SLATE_PICK_SOURCES } from './state';
import { getRequestsState } from './state-default';

export interface ChannelCheckInput {
  requestId: string;
  youtubeChannelId: string | null;
  channel: string | null;
  // The downloaded file, when checked at the completion callback.
  filePath?: string | null;
}

export type ChannelCheckResult =
  | { blocked: false }
  | { blocked: true; reason: string; rejected: boolean };

export function rejectIfChannelBlocked(input: ChannelCheckInput): ChannelCheckResult {
  const row = db.prepare(`
    SELECT u.role, r.source FROM requests r JOIN users u ON u.user_id = r.user_id
     WHERE r.request_id = ?
  `).get(input.requestId) as { role: string; source: string } | undefined;
  // No row (deleted mid-flight): nothing to reject, and the callers' own
  // transitions already treat a missing row as a no-op.
  if (!row || row.role !== 'kid') return { blocked: false };

  const channelId = input.youtubeChannelId?.trim() || null;
  const channel = input.channel?.trim() || null;
  if (!isChannelBlocked(channelId, channel)) return { blocked: false };

  // A kid's own request is rejected in view (reason + Appeal); a slate pick
  // they never asked for just leaves, title and all.
  const { result } = getRequestsState().apply({
    kind: SLATE_PICK_SOURCES.includes(row.source) ? 'mark_channel_blocked_hidden' : 'mark_channel_blocked',
    requestId: input.requestId,
    reason: BLOCKED_CHANNEL_REASON,
    youtubeChannelId: channelId,
    channel,
    filePath: input.filePath ?? null,
  });
  // Not transitioned: the row already left `downloading` (e.g. the kid
  // cancelled). The worker still stops — the channel is blocked either way.
  logger.info(
    { requestId: input.requestId, channelId, rejected: result.transitioned },
    'Kid request from a blocked channel — rejected',
  );
  return { blocked: true, reason: BLOCKED_CHANNEL_REASON, rejected: result.transitioned };
}
