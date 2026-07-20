import { describe, it, expect } from 'vitest';
import { guestCookieArgs } from './util';

describe('guestCookieArgs', () => {
  const jar = '/home/worker/.local/state/eddy/guest-cookies.txt';

  it('emits --cookies <path> when a jar is configured and present', () => {
    expect(guestCookieArgs(jar, true)).toEqual(['--cookies', jar]);
  });

  it('emits nothing when no jar is configured (empty path = feature off)', () => {
    expect(guestCookieArgs('', true)).toEqual([]);
    expect(guestCookieArgs('', false)).toEqual([]);
  });

  it('emits nothing when configured but the file is missing (never fail a download)', () => {
    expect(guestCookieArgs(jar, false)).toEqual([]);
  });
});
