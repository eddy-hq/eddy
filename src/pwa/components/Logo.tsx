import React from 'react';

export function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/*
        Leaf in the wind —
        Leaf body: two bezier curves sharing tip + base, tilted ~20° as if caught mid-gust.
        Center vein runs tip to stem.
        Stem curls gently at the base.
        Two light wind arcs trail to the upper-right.
      */}
      <svg width="32" height="36" viewBox="0 0 32 36" fill="none" aria-hidden>
        {/* Wind arcs — barely-there, suggest air passing */}
        <path
          d="M 22 5 C 27 7, 29 11, 27 15"
          stroke="#6366f1" strokeWidth="1.1" strokeLinecap="round" opacity="0.22"
        />
        <path
          d="M 25 10 C 30 12, 31 17, 29 21"
          stroke="#6366f1" strokeWidth="1.1" strokeLinecap="round" opacity="0.15"
        />

        {/* Leaf body — tilted, soft fill */}
        <path
          d="M 17 2 C 27 6, 28 20, 11 30 C 2 20, 4 6, 17 2 Z"
          fill="#6366f1" fillOpacity="0.1"
          stroke="#6366f1" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        />

        {/* Center vein */}
        <path
          d="M 17 2 C 15 12, 13 21, 11 30"
          stroke="#6366f1" strokeWidth="1" strokeLinecap="round" opacity="0.5"
        />

        {/* Stem with gentle curl */}
        <path
          d="M 11 30 C 9 33, 7 34, 6 32"
          stroke="#6366f1" strokeWidth="1.4" strokeLinecap="round" opacity="0.7"
        />
      </svg>

      <span style={{
        fontFamily: 'var(--font-serif)',
        fontSize: '1.45rem',
        fontWeight: 300,
        letterSpacing: '0.04em',
        color: 'var(--text-secondary)',
        lineHeight: 1,
      }}>
        eddy
      </span>
    </div>
  );
}
