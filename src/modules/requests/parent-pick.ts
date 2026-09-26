// Parent picks (#217): a parent sends a video already in their own library to
// one or more kids' feeds. Each chosen kid gets a ready card of their own,
// sharing the parent's file on disk (no second download), marked
// `source = 'parent_pick'` with the sending parent recorded in `sent_by`.
//
// The parent's choice is the approval, so the guard never runs. The
// household's Blocked channels still apply: a video from a blocked channel is
// refused for every kid, with a message for the parent.
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client';
import { logger } from '../../logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { isChannelBlocked } from '../blocked-channels';
import { resolveUserById, type UserRow } from '../users';
import { HIDDEN_STATUSES, type Status } from './state';
import { getRequestsState } from './state-default';

export const PARENT_PICK_BLOCKED_MESSAGE =
  "This channel is blocked for the kids, so it can't be sent.";
export const PARENT_PICK_NOT_LIVE_MESSAGE =
  'This video is no longer on disk. Restore it first, then send it.';

// What happened for one kid.
//   sent       a new card is in the kid's feed
//   already    the kid already has this video in their feed
//   in_review  the kid has it, but parked for a parent's decision (Decisions)
export type ParentPickOutcome = 'sent' | 'already' | 'in_review';

export interface ParentPickResult {
  kidId: string;
  displayName: string;
  outcome: ParentPickOutcome;
  requestId: string;
}

export interface SendTarget {
  userId: string;
  displayName: string;
}

// Kids a parent can send to, oldest first. Empty for anyone who isn't a
// parent, so the PWA can use it to decide whether to offer Send to at all.
export function listSendTargets(callerId: string): SendTarget[] {
  const caller = resolveUserById(callerId);
  if (caller.role !== 'parent') return [];
  return (db.prepare(
    "SELECT user_id, display_name FROM users WHERE role = 'kid' ORDER BY created_at, user_id",
  ).all() as Array<{ user_id: string; display_name: string }>)
    .map((r) => ({ userId: r.user_id, displayName: r.display_name }));
}

interface SourceRow {
  user_id: string;
  url: string;
  youtube_id: string | null;
  youtube_channel_id: string | null;
  title: string | null;
  channel: string | null;
  description: string | null;
  transcript: string | null;
  duration_secs: number | null;
  file_path: string | null;
  nginx_url: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  file_size_bytes: number | null;
  file_state: string;
  status: string;
}

// Statuses that don't count as "already in their feed": the kid's row is
// gone, refused or failed, so a parent pick makes a fresh card.
const NOT_IN_FEED: Status[] = ['rejected', 'dismissed', 'deleted', 'failed'];

function findKidCopy(kidId: string, youtubeId: string): { requestId: string; status: string } | null {
  const placeholders = NOT_IN_FEED.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT request_id, status FROM requests
      WHERE user_id = ? AND youtube_id = ?
        AND status NOT IN (${placeholders})
      ORDER BY requested_at DESC LIMIT 1`,
  ).get(kidId, youtubeId, ...NOT_IN_FEED) as { request_id: string; status: string } | undefined;
  return row ? { requestId: row.request_id, status: row.status } : null;
}

function requireKid(kidId: string): UserRow {
  const kid = resolveUserById(kidId);
  if (kid.role !== 'kid') throw new ForbiddenError('Parent picks can only be sent to kids');
  return kid;
}

// Send the parent's request `sourceRequestId` to each kid in `kidIds`.
// Throws before writing anything when the caller isn't a parent, a target
// isn't a kid, the video isn't a playable one in the parent's own library, or
// its channel is blocked.
export async function sendParentPick(
  parentId: string,
  sourceRequestId: string,
  kidIds: string[],
): Promise<ParentPickResult[]> {
  const parent = resolveUserById(parentId);
  if (parent.role !== 'parent') throw new ForbiddenError('Only a parent can send a video to a kid');

  const uniqueKidIds = [...new Set(kidIds)];
  if (uniqueKidIds.length === 0) throw new ValidationError('Choose at least one kid');
  const kids = uniqueKidIds.map(requireKid);

  const source = db.prepare(
    `SELECT user_id, url, youtube_id, youtube_channel_id, title, channel, description, transcript,
            duration_secs, file_path, nginx_url, thumbnail_url, published_at, file_size_bytes,
            file_state, status
       FROM requests WHERE request_id = ?`,
  ).get(sourceRequestId) as SourceRow | undefined;
  // Another user's request reads as not found: a parent sends from their own
  // library only.
  if (!source || source.user_id !== parent.user_id) throw new NotFoundError('request');
  if (!['ready', 'watched'].includes(source.status)) {
    throw new ValidationError(`Cannot send a request in status '${source.status}'`);
  }
  if (source.file_state !== 'live' || !source.file_path || !source.youtube_id) {
    throw new ConflictError(PARENT_PICK_NOT_LIVE_MESSAGE);
  }
  if (isChannelBlocked(source.youtube_channel_id, source.channel)) {
    logger.info({ requestId: sourceRequestId, parentId }, 'Parent pick refused — blocked channel');
    throw new ConflictError(PARENT_PICK_BLOCKED_MESSAGE);
  }

  const results: ParentPickResult[] = [];
  for (const kid of kids) {
    const existing = findKidCopy(kid.user_id, source.youtube_id);
    if (existing) {
      results.push({
        kidId: kid.user_id,
        displayName: kid.display_name,
        outcome: HIDDEN_STATUSES.includes(existing.status as Status) ? 'in_review' : 'already',
        requestId: existing.requestId,
      });
      continue;
    }

    const requestId = uuidv7();
    const { settled } = getRequestsState().apply({
      kind: 'create_parent_pick',
      requestId,
      input: {
        userId: kid.user_id,
        sentBy: parent.user_id,
        url: source.url,
        youtubeId: source.youtube_id,
        youtubeChannelId: source.youtube_channel_id,
        title: source.title,
        channel: source.channel,
        description: source.description,
        transcript: source.transcript,
        durationSecs: source.duration_secs,
        filePath: source.file_path,
        nginxUrl: source.nginx_url,
        thumbnailUrl: source.thumbnail_url,
        publishedAt: source.published_at,
        fileSizeBytes: source.file_size_bytes,
      },
    });
    await settled;
    results.push({ kidId: kid.user_id, displayName: kid.display_name, outcome: 'sent', requestId });
  }

  logger.info(
    { sourceRequestId, parentId, sent: results.filter((r) => r.outcome === 'sent').length, kids: results.length },
    'Parent pick sent',
  );
  return results;
}
