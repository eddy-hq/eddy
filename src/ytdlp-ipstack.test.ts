import { describe, it, expect } from 'vitest';
import { ipStackArgs } from './ytdlp-ipstack';

describe('ipStackArgs', () => {
  it('pins IPv4', () => {
    expect(ipStackArgs('ipv4')).toEqual(['--force-ipv4']);
  });

  it('pins IPv6', () => {
    expect(ipStackArgs('ipv6')).toEqual(['--force-ipv6']);
  });

  it('leaves the stack unpinned on auto', () => {
    expect(ipStackArgs('auto')).toEqual([]);
  });
});
