// Argument parsing for the block-channel CLI, kept pure for tests.

export type BlockChannelCommand =
  | { kind: 'block'; target: string; reason: string | null; by: string | null; name: string | null }
  | { kind: 'list' }
  | { kind: 'unblock'; channelId: string }
  | { kind: 'help' };

export const USAGE = `Usage:
  npm run block-channel -- <channel URL | @handle | channel id | video URL> [--reason "<note>"] [--by <parent user id>] [--name "<display name>"]
  npm run block-channel -- --list
  npm run block-channel -- --unblock <channel id>

Blocks a YouTube channel for every kid in the household. --by defaults to the
only parent when there is exactly one. --name is used only when the channel's
title can't be looked up (a bare channel id offline).`;

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgsError';
  }
}

const VALUE_FLAGS = new Set(['--reason', '--by', '--name', '--unblock']);

export function parseBlockChannelArgs(argv: readonly string[]): BlockChannelCommand {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let list = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--list') list = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ArgsError(`${arg} needs a value`);
      values.set(arg, value);
      i++;
    } else if (arg.startsWith('--')) {
      throw new ArgsError(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (help) return { kind: 'help' };
  const unblock = values.get('--unblock');
  const modes = [list, unblock !== undefined, positional.length > 0].filter(Boolean).length;
  if (modes === 0) return { kind: 'help' };
  if (modes > 1) throw new ArgsError('Give one of: a channel to block, --list, or --unblock <id>');
  if (list) return { kind: 'list' };
  if (unblock !== undefined) return { kind: 'unblock', channelId: unblock.trim() };
  if (positional.length > 1) throw new ArgsError('Block one channel at a time');

  const reason = values.get('--reason')?.trim() || null;
  return {
    kind: 'block',
    target: positional[0]!,
    reason,
    by: values.get('--by')?.trim() || null,
    name: values.get('--name')?.trim() || null,
  };
}
