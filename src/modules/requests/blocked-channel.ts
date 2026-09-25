// Kid requests from a Blocked channel. The worker asks, once it knows the
// video's channel (after the metadata fetch) and before it downloads or asks
// the guard: a kid's request from a blocked channel is rejected here with a
// kid-facing reason, and the guard never runs on it. An adult's request is
// never affected.
import { db } from '../../db/client';
import { NotFoundError } from '../../errors';
import { logger } from '../../logger';
import { BLOCKED_CHANNEL_REASON, isChannelBlocked } from '../blocked-channels';
import { getRequestsState } from './state-default';

export interface ChannelCheckInput {
  requestId: string;
  youtubeChannelId: string | null;
  channel: string | null;
}

export type ChannelCheckResult =
  | { blocked: false }
  | { blocked: true; reason: string; rejected: boolean };

export function rejectIfChannelBlocked(input: ChannelCheckInput): ChannelCheckResult {
  const row = db.prepare(`
    SELECT u.role FROM requests r JOIN users u ON u.user_id = r.user_id
     WHERE r.request_id = ?
  `).get(input.requestId) as { role: string } | undefined;
  if (!row) throw new NotFoundError(`request ${input.requestId}`);
  if (row.role !== 'kid') return { blocked: false };

  const channelId = input.youtubeChannelId?.trim() || null;
  const channel = input.channel?.trim() || null;
  if (!isChannelBlocked(channelId, channel)) return { blocked: false };

  const { result } = getRequestsState().apply({
    kind: 'mark_channel_blocked',
    requestId: input.requestId,
    reason: BLOCKED_CHANNEL_REASON,
    youtubeChannelId: channelId,
    channel,
  });
  // Not transitioned: the row already left `downloading` (e.g. the kid
  // cancelled). The worker still stops — the channel is blocked either way.
  logger.info(
    { requestId: input.requestId, channelId, rejected: result.transitioned },
    'Kid request from a blocked channel — rejected before download',
  );
  return { blocked: true, reason: BLOCKED_CHANNEL_REASON, rejected: result.transitioned };
}
