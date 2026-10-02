// A request a parent has blocked for the kid while it was still in flight
// (#223): a Block, or a Review change to Block, that landed while the video
// was downloading or awaiting the second pass, which no parent-block
// transition can reach. It is caught before it can become visible, at the
// worker's download-complete callback and before the second pass clears it,
// and leaves through the Block path.
import { db } from '../../db/client';
import { getRequestsState } from './state-default';

export interface RequestOrigin {
  userId: string;
  youtubeId: string | null;
  requestedAt: string;
}

// Whose request it is, for which video, and when it was asked for. Null when
// the row has gone.
export function readRequestOrigin(requestId: string): RequestOrigin | null {
  const row = db.prepare(
    'SELECT user_id, youtube_id, requested_at FROM requests WHERE request_id = ?',
  ).get(requestId) as { user_id: string; youtube_id: string | null; requested_at: string } | undefined;
  return row ? { userId: row.user_id, youtubeId: row.youtube_id, requestedAt: row.requested_at } : null;
}

// Remove a request held in guard_review as a parent Block: parked out of
// sight first (the only way out of guard_review that shows nothing), then
// removed through mark_parent_blocked, file included. True when removed.
export async function removeParentBlockedInReview(requestId: string, parentId: string, reason: string): Promise<boolean> {
  const parked = getRequestsState().apply({
    kind: 'mark_second_pass_parked', requestId, verdict: 'clear_no', reason,
  });
  if (!parked.result.transitioned) return false;
  const { result, settled } = getRequestsState().apply({
    kind: 'mark_parent_blocked', requestId, parentId, reason,
  });
  await settled;
  return result.transitioned;
}
