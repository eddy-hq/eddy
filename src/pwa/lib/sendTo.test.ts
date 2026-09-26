import { describe, expect, it } from 'vitest';
import {
  actionGridColumns,
  armedDeleteSpan,
  canSendTo,
  pickerOptions,
  sendResultMessage,
  type SendResult,
  type SendTarget,
} from './sendTo';

const BOY1: SendTarget = { userId: 'kid-1', displayName: 'Boy1' };
const BOY2: SendTarget = { userId: 'kid-2', displayName: 'Boy2' };
const BOY3: SendTarget = { userId: 'kid-3', displayName: 'Boy3' };

function result(kid: SendTarget, outcome: SendResult['outcome']): SendResult {
  return { kidId: kid.userId, displayName: kid.displayName, outcome, requestId: `req-${kid.userId}` };
}

describe('pickerOptions', () => {
  it('offers each kid by name, then Both', () => {
    expect(pickerOptions([BOY1, BOY2])).toEqual([
      { key: 'kid-1', label: 'Boy1', kidIds: ['kid-1'] },
      { key: 'kid-2', label: 'Boy2', kidIds: ['kid-2'] },
      { key: 'all', label: 'Both', kidIds: ['kid-1', 'kid-2'] },
    ]);
  });

  it('offers just the one kid when there is only one', () => {
    expect(pickerOptions([BOY1])).toEqual([{ key: 'kid-1', label: 'Boy1', kidIds: ['kid-1'] }]);
  });

  it('says Everyone rather than Both for more than two kids', () => {
    const all = pickerOptions([BOY1, BOY2, BOY3]).at(-1);
    expect(all).toEqual({ key: 'all', label: 'Everyone', kidIds: ['kid-1', 'kid-2', 'kid-3'] });
  });

  it('offers nothing without kids', () => {
    expect(pickerOptions([])).toEqual([]);
  });
});

describe('canSendTo', () => {
  it('is offered to a parent on a playable video', () => {
    expect(canSendTo([BOY1], true)).toBe(true);
  });

  it('is hidden for a kid (no send targets) or while targets load', () => {
    expect(canSendTo([], true)).toBe(false);
    expect(canSendTo(undefined, true)).toBe(false);
  });

  it('is hidden on a video that is not ready', () => {
    expect(canSendTo([BOY1], false)).toBe(false);
  });
});

describe('ActionGrid layout', () => {
  it('is 2×2 for a parent with Send to, three-up otherwise', () => {
    expect(actionGridColumns(true)).toBe(2);
    expect(actionGridColumns(false)).toBe(3);
  });

  it('lets the armed Delete span every column but Save', () => {
    expect(armedDeleteSpan(3)).toBe(2);
    expect(armedDeleteSpan(2)).toBe(1);
  });
});

describe('sendResultMessage', () => {
  it('says Sent when every kid got a new card', () => {
    expect(sendResultMessage([result(BOY1, 'sent'), result(BOY2, 'sent')])).toBe('Sent');
  });

  it('says Already in their feed when every kid already had it', () => {
    expect(sendResultMessage([result(BOY1, 'already')])).toBe('Already in their feed');
    expect(sendResultMessage([result(BOY1, 'already'), result(BOY2, 'already')])).toBe('Already in their feed');
  });

  it('spells out a mixed outcome per kid', () => {
    expect(sendResultMessage([result(BOY1, 'sent'), result(BOY2, 'already')]))
      .toBe('Sent to Boy1 · Boy2 already has it');
  });

  it('points a copy parked for review at Decisions', () => {
    expect(sendResultMessage([result(BOY1, 'sent'), result(BOY2, 'in_review')]))
      .toBe('Sent to Boy1 · Boy2: waiting in Decisions');
  });

  it('handles an empty result list', () => {
    expect(sendResultMessage([])).toBe('Nothing sent');
  });
});
