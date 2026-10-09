import { describe, expect, it } from 'vitest';
import { guessDeviceType, inviteFromSearch, parseSetupInput, reconcileIdentitySearch } from './deviceIdentity';

const INVITE = `ZW5yb2w6MTExMTExMTEtMTExMS03MTExLTgxMTEtMTExMTExMTExMTExOjE3NjcyMjkyMDAwMDA.${'ab'.repeat(32)}`;
const ME = '11111111-1111-7111-8111-111111111111';
const SOMEONE = '22222222-2222-7222-8222-222222222222';

describe('inviteFromSearch', () => {
  it('reads a well-formed invite', () => {
    expect(inviteFromSearch(`?invite=${INVITE}`)).toBe(INVITE);
  });

  it('ignores a missing or malformed one', () => {
    expect(inviteFromSearch('')).toBeNull();
    expect(inviteFromSearch('?invite=nope')).toBeNull();
  });
});

describe('parseSetupInput', () => {
  it('takes a bare invite, a link, or text around a link', () => {
    expect(parseSetupInput(` ${INVITE} `)).toBe(INVITE);
    expect(parseSetupInput(`https://eddy.example/setup?invite=${INVITE}`)).toBe(INVITE);
    expect(parseSetupInput(`Here you go: https://eddy.example/setup?invite=${INVITE} thanks`)).toBe(INVITE);
  });

  it('refuses an old userId link — that no longer sets a device up', () => {
    expect(parseSetupInput(`https://eddy.example/feed?userId=${ME}`)).toBeNull();
    expect(parseSetupInput('')).toBeNull();
  });
});

describe('reconcileIdentitySearch', () => {
  it('leaves a URL that already names the device owner alone', () => {
    expect(reconcileIdentitySearch(`?userId=${ME}&tab=saved`, ME)).toBeNull();
  });

  it('adds the owner to a URL with no user', () => {
    expect(reconcileIdentitySearch('', ME)).toBe(`?userId=${ME}`);
  });

  it('replaces someone else’s id and a display-name alias, keeping the rest', () => {
    expect(reconcileIdentitySearch(`?userId=${SOMEONE}&tab=saved`, ME)).toBe(`?tab=saved&userId=${ME}`);
    expect(reconcileIdentitySearch('?user=Boy1', ME)).toBe(`?userId=${ME}`);
    expect(reconcileIdentitySearch(`?userId=${ME}&userId=${SOMEONE}`, ME)).toBe(`?userId=${ME}`);
  });
});

describe('guessDeviceType', () => {
  it('tells a tablet, a phone and a desktop apart', () => {
    expect(guessDeviceType('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('tablet');
    expect(guessDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile')).toBe('phone');
    expect(guessDeviceType('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop');
  });
});
