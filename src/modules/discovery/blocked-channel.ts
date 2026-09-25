// What blocking a channel does to the Candidate pool. The block itself lives
// in modules/blocked-channels; this is the discovery side, since discovery
// owns candidate_pool.
//
// Every kid's not-yet-picked candidates from the channel are taken out of the
// pool — the same 'guard_rejected' status a parent's Block on a Decisions card
// uses. guard_verdict is left as the guard set it: the guard didn't judge
// this, the parent's channel rule did. Picked candidates ('requested') are
// already requests — downloaded content a kid may have — and are left alone;
// so are dismissed ones (the kid's own call) and adults' rows.
import { db } from '../../db/client';
import { logger } from '../../logger';
import { matchesChannelSql, recordChannelBlock, type BlockInput } from '../blocked-channels';

const PURGE_FROM = ['pending', 'scored', 'guard_pending', 'surfaced'];

export function purgeBlockedChannelFromPool(channelId: string, displayName: string): number {
  const placeholders = PURGE_FROM.map((_, i) => `@s${i}`).join(', ');
  const params: Record<string, string> = { channelId, displayName };
  PURGE_FROM.forEach((s, i) => { params[`s${i}`] = s; });
  const res = db.prepare(`
    UPDATE candidate_pool SET status = 'guard_rejected'
     WHERE status IN (${placeholders})
       AND user_id IN (SELECT user_id FROM users WHERE role = 'kid')
       AND ${matchesChannelSql('channel_id', 'channel')}
  `).run(params);
  return res.changes;
}

export interface ChannelBlockOutcome {
  channelId: string;
  displayName: string;
  alreadyBlocked: boolean;
  poolRowsRemoved: number;
}

// Block a channel household-wide and take its queued candidates out of every
// kid's pool, in one transaction. Re-blocking an already-blocked channel
// still sweeps the pool (cheap, and catches anything that slipped in).
export function blockChannel(input: BlockInput): ChannelBlockOutcome {
  const out = db.transaction(() => {
    const { created } = recordChannelBlock(input);
    const poolRowsRemoved = purgeBlockedChannelFromPool(input.channelId, input.displayName);
    return { alreadyBlocked: !created, poolRowsRemoved };
  })();
  logger.info(
    { channelId: input.channelId, alreadyBlocked: out.alreadyBlocked, poolRowsRemoved: out.poolRowsRemoved },
    'Channel blocked',
  );
  return { channelId: input.channelId, displayName: input.displayName, ...out };
}
