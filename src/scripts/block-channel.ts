#!/usr/bin/env tsx
/**
 * npm run block-channel -- <channel URL | @handle | channel id | video URL> [--reason "..."] [--by <parent id>]
 * npm run block-channel -- --list
 * npm run block-channel -- --unblock <channel id>
 *
 * Blocks a YouTube channel household-wide: no kid's slate gets its videos and
 * a kid's request from it is rejected with a reason. Adults are unaffected.
 * Prints counts only — never kid titles or consumption details.
 */
import 'dotenv/config';
import { runMigrations } from '../db/migrate';
import { db } from '../db/client';
import { channelIdentity } from '../discovery-metadata';
import {
  getBlockedChannel,
  isChannelId,
  listBlockedChannels,
  parseChannelRef,
  unblockChannel,
} from '../modules/blocked-channels';
import { blockChannel } from '../modules/discovery';
import { resolveUserById } from '../modules/users';
import { ArgsError, USAGE, parseBlockChannelArgs, type BlockChannelCommand } from './block-channel-lib';

/* eslint-disable no-console */

function resolveParent(by: string | null): string {
  if (by) {
    const user = resolveUserById(by);
    if (user.role !== 'parent') throw new ArgsError('--by must be a parent');
    return user.user_id;
  }
  const parents = db.prepare("SELECT user_id FROM users WHERE role = 'parent'").all() as Array<{ user_id: string }>;
  if (parents.length !== 1) throw new ArgsError('More than one parent (or none): pass --by <parent user id>');
  return parents[0]!.user_id;
}

async function resolveChannel(target: string, fallbackName: string | null): Promise<{ channelId: string; displayName: string }> {
  const ref = parseChannelRef(target);
  if (!ref) throw new ArgsError(`Not a channel URL, @handle, channel id or video URL: ${target}`);
  try {
    const found = await channelIdentity(ref);
    if (found) return found;
  } catch (err) {
    if (ref.kind !== 'channel_id') throw err;
    console.warn(`Could not look the channel up (${(err as Error).message}).`);
  }
  if (ref.kind === 'channel_id' && fallbackName) return { channelId: ref.channelId, displayName: fallbackName };
  if (ref.kind === 'channel_id') throw new ArgsError('Could not look up that channel id; pass --name "<display name>" to block it anyway');
  throw new ArgsError(`No channel found for ${target}`);
}

async function run(cmd: BlockChannelCommand): Promise<void> {
  if (cmd.kind === 'help') {
    console.log(USAGE);
    return;
  }

  if (cmd.kind === 'list') {
    const rows = listBlockedChannels();
    if (rows.length === 0) {
      console.log('No blocked channels.');
      return;
    }
    for (const r of rows) {
      console.log(`${r.channelId}  ${r.displayName}  (blocked ${r.blockedAt})${r.reason ? `  — ${r.reason}` : ''}`);
    }
    console.log(`${rows.length} blocked channel${rows.length === 1 ? '' : 's'}.`);
    return;
  }

  if (cmd.kind === 'unblock') {
    if (!isChannelId(cmd.channelId)) throw new ArgsError('--unblock takes a channel id (UC...); see --list');
    const existing = getBlockedChannel(cmd.channelId);
    if (!unblockChannel(cmd.channelId)) {
      console.log(`${cmd.channelId} was not blocked.`);
      return;
    }
    console.log(`Unblocked ${existing?.displayName ?? cmd.channelId} (${cmd.channelId}).`);
    console.log('Candidates removed when it was blocked stay out; new videos from it can reach the pool again.');
    return;
  }

  const parentId = resolveParent(cmd.by);
  const channel = await resolveChannel(cmd.target, cmd.name);
  const out = blockChannel({ ...channel, reason: cmd.reason, blockedBy: parentId });
  console.log(`${out.alreadyBlocked ? 'Already blocked' : 'Blocked'} ${out.displayName} (${out.channelId}).`);
  console.log(`Queued candidates removed from kids' pools: ${out.poolRowsRemoved}.`);
}

async function main(): Promise<void> {
  let cmd: BlockChannelCommand;
  try {
    cmd = parseBlockChannelArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    process.exit(2);
  }
  runMigrations();
  await run(cmd);
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error(err instanceof ArgsError ? err.message : err);
  process.exit(1);
});
