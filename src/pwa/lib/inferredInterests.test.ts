import { describe, expect, it } from 'vitest';
import {
  shouldShowBand,
  dropProposal,
  promoteProposal,
  type InferredInterest,
  type MyInterest,
} from './inferredInterests';

function proposal(over: Partial<InferredInterest> = {}): InferredInterest {
  return {
    interestId: 'i-1',
    label: 'Woodworking',
    category: 'Making',
    followerCount: 2,
    confidence: 0.8,
    ...over,
  };
}

function declared(over: Partial<MyInterest> = {}): MyInterest {
  return {
    interestId: 'd-1',
    label: 'Economics',
    rank: 1,
    expertise: 'comfortable',
    ...over,
  };
}

describe('shouldShowBand', () => {
  it('hides the band when there are no proposals', () => {
    expect(shouldShowBand([])).toBe(false);
  });

  it('hides the band while proposals are still loading (undefined)', () => {
    expect(shouldShowBand(undefined)).toBe(false);
  });

  it('shows the band when at least one proposal exists', () => {
    expect(shouldShowBand([proposal()])).toBe(true);
  });
});

describe('dropProposal', () => {
  it('removes the matching proposal from the band', () => {
    const band = [proposal({ interestId: 'i-1' }), proposal({ interestId: 'i-2' })];
    expect(dropProposal(band, 'i-1')).toEqual([proposal({ interestId: 'i-2' })]);
  });

  it('leaves the band unchanged when the id is not present', () => {
    const band = [proposal({ interestId: 'i-1' })];
    expect(dropProposal(band, 'missing')).toEqual(band);
  });
});

describe('promoteProposal', () => {
  it('appends the kept proposal to the declared list at the next rank', () => {
    const declaredList = [declared({ interestId: 'd-1', rank: 1 }), declared({ interestId: 'd-2', rank: 2 })];
    const band = [proposal({ interestId: 'i-1', label: 'Woodworking' })];

    const next = promoteProposal(declaredList, band, 'i-1');

    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      interestId: 'i-1',
      label: 'Woodworking',
      rank: 3,
      expertise: 'comfortable',
    });
  });

  it('ranks the first kept interest at 1 when the declared list is empty', () => {
    const band = [proposal({ interestId: 'i-1' })];
    const next = promoteProposal([], band, 'i-1');
    expect(next).toHaveLength(1);
    expect(next[0].rank).toBe(1);
  });

  it('does not interleave — the promoted item is always last by rank', () => {
    const declaredList = [declared({ interestId: 'd-1', rank: 5 })];
    const band = [proposal({ interestId: 'i-1' })];
    const next = promoteProposal(declaredList, band, 'i-1');
    expect(next[next.length - 1].rank).toBe(6);
  });

  it('is a no-op when the interest is already declared (double-Keep guard)', () => {
    const declaredList = [declared({ interestId: 'i-1', rank: 1 })];
    const band = [proposal({ interestId: 'i-1' })];
    expect(promoteProposal(declaredList, band, 'i-1')).toEqual(declaredList);
  });

  it('is a no-op when the interest is not in the band', () => {
    const declaredList = [declared({ interestId: 'd-1', rank: 1 })];
    expect(promoteProposal(declaredList, [], 'missing')).toEqual(declaredList);
  });
});
