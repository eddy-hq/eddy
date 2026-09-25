// "Block channel" on a Decisions card: the card's video is recorded as a
// parent Block for every kid on the card (exactly as the Block action does),
// then the video's channel is blocked household-wide, which takes every kid's
// queued candidates from it out of the pool. The channel's other cards leave
// the queue because the queue skips Blocked channels.
import { db } from '../../db/client';
import { ValidationError } from '../../errors';
import { blockChannel } from '../discovery';
import { recordDecision, type DecisionOutcome } from './decide';
import type { SubjectType } from './util';

export interface CardSubjectRef {
  subjectType: SubjectType;
  subjectId: string;
}

export interface BlockChannelResult {
  channel: { channelId: string; displayName: string };
  alreadyBlocked: boolean;
  poolRowsRemoved: number;
  outcomes: DecisionOutcome[];
}

interface ChannelRow {
  channel_id: string | null;
  channel: string | null;
}

// The channel a subject's video came from. A candidate without a channel id
// (an older row) borrows one from any download of the same video.
function channelOf(s: CardSubjectRef): ChannelRow | undefined {
  if (s.subjectType === 'request') {
    return db.prepare(
      'SELECT youtube_channel_id AS channel_id, channel FROM requests WHERE request_id = ?',
    ).get(s.subjectId) as ChannelRow | undefined;
  }
  return db.prepare(`
    SELECT COALESCE(cp.channel_id, (
             SELECT r.youtube_channel_id FROM requests r
              WHERE r.youtube_id = cp.external_id AND r.youtube_channel_id IS NOT NULL
              ORDER BY r.requested_at DESC LIMIT 1
           )) AS channel_id,
           cp.channel
      FROM candidate_pool cp WHERE cp.candidate_id = ?
  `).get(s.subjectId) as ChannelRow | undefined;
}

export function channelForSubjects(subjects: readonly CardSubjectRef[]): { channelId: string; displayName: string } {
  let name: string | null = null;
  for (const s of subjects) {
    const row = channelOf(s);
    name = name ?? row?.channel ?? null;
    if (row?.channel_id) return { channelId: row.channel_id, displayName: row.channel ?? name ?? row.channel_id };
  }
  throw new ValidationError('This card has no channel id to block');
}

export async function blockChannelFromCard(
  parentId: string,
  subjects: readonly CardSubjectRef[],
  reason: string | null,
  now: Date = new Date(),
): Promise<BlockChannelResult> {
  // Resolve first, so a card without a channel id changes nothing.
  const channel = channelForSubjects(subjects);
  const outcomes: DecisionOutcome[] = [];
  for (const s of subjects) {
    outcomes.push(await recordDecision(parentId, { ...s, verdict: 'clear_no' }, now));
  }
  const block = blockChannel({ ...channel, reason, blockedBy: parentId, now });
  return { channel, alreadyBlocked: block.alreadyBlocked, poolRowsRemoved: block.poolRowsRemoved, outcomes };
}
