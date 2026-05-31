// Responsive multi-column layout for the feed's card lists. The PWA is
// phone-first — every list was a single full-width column, which on an iPad
// stretched each 16:9 card to the viewport width. These helpers drive a CSS
// grid that flows from one column on a phone to two on an iPad in portrait and
// three in landscape, capped so a 12.9" iPad Pro doesn't sprout a fourth.
//
// Column count is purely width-driven via `repeat(auto-fill, minmax(min, 1fr))`
// — no breakpoints, no media queries (the PWA has no CSS layer for them).
// `feedColumns`/`columnsAtWidth` mirror the CSS auto-fill formula so the
// intended 1/2/3 behaviour is unit-testable without a DOM — the harness can't
// browser-test the PWA AFK (#174), so the column logic is asserted here.

// Caps the feed content column so very wide tablets settle at three columns
// rather than four-plus. The caller centres it with `margin: 0 auto`.
export const FEED_MAX_WIDTH = 1040;

// Horizontal padding each card list holds inside the content column (the
// historical `padding: 0 16px`), subtracted when working out usable width.
export const FEED_SIDE_PAD = 16;

// Gap between grid cells, both axes.
export const GRID_GAP = 14;

// Narrowest a card may get before the grid drops a column. Big Today /
// "You asked" cards carry a 16:9 thumbnail + serif title; compact past-day
// rows are denser and tolerate a slightly narrower track.
export const CARD_MIN_COL = 300;
export const COMPACT_MIN_COL = 280;

// The grid-template-columns value: as many equal tracks as fit at `minColPx`
// or wider, one per row on a phone.
export function gridColumns(minColPx: number): string {
  return `repeat(auto-fill, minmax(${minColPx}px, 1fr))`;
}

// Number of columns `repeat(auto-fill, minmax(minColPx, 1fr))` yields in a
// track of `containerPx`, per the CSS Grid spec: gaps sit between tracks only,
// so n tracks need n*min + (n-1)*gap <= container, i.e.
// n = floor((container + gap) / (min + gap)). Always at least one.
export function columnsAtWidth(containerPx: number, minColPx: number, gapPx: number): number {
  if (containerPx <= 0) return 1;
  return Math.max(1, Math.floor((containerPx + gapPx) / (minColPx + gapPx)));
}

// Columns the feed shows at a given viewport width: clamp to the content cap,
// subtract the list's side padding, then apply the auto-fill formula.
export function feedColumns(viewportPx: number, minColPx: number): number {
  const content = Math.min(viewportPx, FEED_MAX_WIDTH) - FEED_SIDE_PAD * 2;
  return columnsAtWidth(content, minColPx, GRID_GAP);
}
