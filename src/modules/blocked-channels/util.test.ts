import { describe, expect, it } from 'vitest';
import { isChannelId, parseChannelRef } from './util';

const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const VIDEO_ID = 'abcdefghijk';

describe('parseChannelRef', () => {
  it('reads a bare channel id and a /channel/ URL', () => {
    expect(parseChannelRef(CHANNEL_ID)).toEqual({ kind: 'channel_id', channelId: CHANNEL_ID });
    expect(parseChannelRef(`https://www.youtube.com/channel/${CHANNEL_ID}/videos`))
      .toEqual({ kind: 'channel_id', channelId: CHANNEL_ID });
  });

  it('reads a bare @handle and a handle URL, with or without scheme', () => {
    expect(parseChannelRef('@placeholder.handle')).toEqual({ kind: 'handle', handle: '@placeholder.handle' });
    expect(parseChannelRef('https://www.youtube.com/@placeholder/featured')).toEqual({ kind: 'handle', handle: '@placeholder' });
    expect(parseChannelRef('youtube.com/@placeholder')).toEqual({ kind: 'handle', handle: '@placeholder' });
    expect(parseChannelRef('https://m.youtube.com/@placeholder')).toEqual({ kind: 'handle', handle: '@placeholder' });
  });

  it('reads a legacy /user/ URL', () => {
    expect(parseChannelRef('https://www.youtube.com/user/PlaceholderUser')).toEqual({ kind: 'username', username: 'PlaceholderUser' });
  });

  it('reads video URLs in their usual shapes, and a bare video id', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${VIDEO_ID}&t=30`,
      `https://youtu.be/${VIDEO_ID}?si=placeholder`,
      `https://www.youtube.com/shorts/${VIDEO_ID}`,
      `https://www.youtube.com/live/${VIDEO_ID}`,
      VIDEO_ID,
    ]) {
      expect(parseChannelRef(url)).toEqual({ kind: 'video', videoId: VIDEO_ID });
    }
  });

  it('refuses what it cannot resolve', () => {
    expect(parseChannelRef('')).toBeNull();
    expect(parseChannelRef('https://www.youtube.com/c/PlaceholderVanity')).toBeNull();
    expect(parseChannelRef('https://example.test/@placeholder')).toBeNull();
    expect(parseChannelRef('https://www.youtube.com/watch')).toBeNull();
    expect(parseChannelRef('not a channel')).toBeNull();
  });
});

describe('isChannelId', () => {
  it('accepts UC ids only', () => {
    expect(isChannelId(CHANNEL_ID)).toBe(true);
    expect(isChannelId('UCshort')).toBe(false);
    expect(isChannelId('@placeholder')).toBe(false);
  });
});
