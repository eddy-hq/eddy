import { describe, expect, it } from 'vitest';
import { ArgsError, parseBlockChannelArgs } from './block-channel-lib';

describe('parseBlockChannelArgs', () => {
  it('reads a block with its options', () => {
    expect(parseBlockChannelArgs(['@placeholder', '--reason', 'Placeholder reason', '--by', 'parent-1']))
      .toEqual({ kind: 'block', target: '@placeholder', reason: 'Placeholder reason', by: 'parent-1', name: null });
    expect(parseBlockChannelArgs(['--name', 'Placeholder channel', 'UCaaaaaaaaaaaaaaaaaaaaaa']))
      .toEqual({ kind: 'block', target: 'UCaaaaaaaaaaaaaaaaaaaaaa', reason: null, by: null, name: 'Placeholder channel' });
  });

  it('reads --list and --unblock', () => {
    expect(parseBlockChannelArgs(['--list'])).toEqual({ kind: 'list' });
    expect(parseBlockChannelArgs(['--unblock', 'UCaaaaaaaaaaaaaaaaaaaaaa'])).toEqual({ kind: 'unblock', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' });
  });

  it('shows help with no arguments or --help', () => {
    expect(parseBlockChannelArgs([])).toEqual({ kind: 'help' });
    expect(parseBlockChannelArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('refuses mixed modes, missing values, unknown options and two targets', () => {
    expect(() => parseBlockChannelArgs(['--list', '@placeholder'])).toThrow(ArgsError);
    expect(() => parseBlockChannelArgs(['--unblock'])).toThrow(ArgsError);
    expect(() => parseBlockChannelArgs(['@placeholder', '--reason'])).toThrow(ArgsError);
    expect(() => parseBlockChannelArgs(['@placeholder', '--force'])).toThrow(ArgsError);
    expect(() => parseBlockChannelArgs(['@one', '@two'])).toThrow(ArgsError);
  });
});
