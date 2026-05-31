import { describe, it, expect } from 'vitest';
import {
  CARD_MIN_COL,
  COMPACT_MIN_COL,
  FEED_MAX_WIDTH,
  GRID_GAP,
  columnsAtWidth,
  feedColumns,
  gridColumns,
} from './feed-grid';

describe('gridColumns', () => {
  it('emits an auto-fill minmax track list', () => {
    expect(gridColumns(300)).toBe('repeat(auto-fill, minmax(300px, 1fr))');
  });
});

describe('columnsAtWidth', () => {
  it('never returns fewer than one column', () => {
    expect(columnsAtWidth(0, 300, 14)).toBe(1);
    expect(columnsAtWidth(-50, 300, 14)).toBe(1);
    expect(columnsAtWidth(120, 300, 14)).toBe(1);
  });

  it('counts tracks with the inter-track gap, not a trailing one', () => {
    // Two 300px tracks + one 14px gap = 614 exactly fits; a third needs 928.
    expect(columnsAtWidth(613, 300, 14)).toBe(1);
    expect(columnsAtWidth(614, 300, 14)).toBe(2);
    expect(columnsAtWidth(927, 300, 14)).toBe(2);
    expect(columnsAtWidth(928, 300, 14)).toBe(3);
  });
});

describe('feedColumns — big Today / You-asked cards', () => {
  // Representative logical-pixel widths across the devices the kids use.
  it('is one column on phones', () => {
    expect(feedColumns(390, CARD_MIN_COL)).toBe(1); // iPhone
    expect(feedColumns(480, CARD_MIN_COL)).toBe(1);
  });

  it('is two columns on an iPad in portrait', () => {
    expect(feedColumns(768, CARD_MIN_COL)).toBe(2); // iPad / Mini
    expect(feedColumns(820, CARD_MIN_COL)).toBe(2); // iPad Air
  });

  it('is three columns on an iPad in landscape', () => {
    expect(feedColumns(1024, CARD_MIN_COL)).toBe(3);
    expect(feedColumns(1180, CARD_MIN_COL)).toBe(3); // iPad Pro 11"
  });

  it('caps at three on very wide tablets', () => {
    expect(feedColumns(1366, CARD_MIN_COL)).toBe(3); // iPad Pro 12.9"
    expect(feedColumns(1920, CARD_MIN_COL)).toBe(3);
  });
});

describe('feedColumns — compact past-day rows', () => {
  it('matches the 1/2/3 progression at the same widths', () => {
    expect(feedColumns(390, COMPACT_MIN_COL)).toBe(1);
    expect(feedColumns(768, COMPACT_MIN_COL)).toBe(2);
    expect(feedColumns(1024, COMPACT_MIN_COL)).toBe(3);
    expect(feedColumns(1366, COMPACT_MIN_COL)).toBe(3);
  });
});

describe('the cap holds the feed to three columns', () => {
  // Whatever the viewport, content width can't exceed the cap, so neither
  // card type can ever reach a fourth track.
  it('never exceeds three for either min-column width', () => {
    const content = FEED_MAX_WIDTH - 16 * 2;
    expect(columnsAtWidth(content, CARD_MIN_COL, GRID_GAP)).toBe(3);
    expect(columnsAtWidth(content, COMPACT_MIN_COL, GRID_GAP)).toBe(3);
  });
});
