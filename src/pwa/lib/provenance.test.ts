import { describe, expect, it } from 'vitest';
import { sentFromLabel, sentWhyLine, sourceKind } from './provenance';

describe('sourceKind', () => {
  it('maps each request source to its provenance kind', () => {
    expect(sourceKind('share_sheet')).toBe('req');
    expect(sourceKind('channel_subscription')).toBe('follow');
    expect(sourceKind('recommended')).toBe('pick');
    expect(sourceKind('parent_pick')).toBe('sent');
  });

  it('has no pill for legacy or missing sources', () => {
    expect(sourceKind('search')).toBeNull();
    expect(sourceKind(null)).toBeNull();
    expect(sourceKind(undefined)).toBeNull();
  });
});

describe('sentFromLabel', () => {
  it('names the sending parent', () => {
    expect(sentFromLabel('Parent1')).toBe('From Parent1');
  });

  it('trims the name', () => {
    expect(sentFromLabel('  Parent1 ')).toBe('From Parent1');
  });

  it('falls back to a neutral line without a name', () => {
    expect(sentFromLabel(null)).toBe('From a grown-up');
    expect(sentFromLabel(undefined)).toBe('From a grown-up');
    expect(sentFromLabel('   ')).toBe('From a grown-up');
  });
});

describe('sentWhyLine', () => {
  it('names the sending parent, with a neutral fallback', () => {
    expect(sentWhyLine('Parent1')).toBe('Parent1 sent you this.');
    expect(sentWhyLine(null)).toBe('A grown-up sent you this.');
  });
});
