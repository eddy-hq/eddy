import React from 'react';

export function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {/* Eddy mark — three layered waves suggesting a current/swirl */}
      <svg
        width="38"
        height="26"
        viewBox="0 0 38 26"
        fill="none"
        aria-hidden
      >
        {/* Top wave — lightest */}
        <path
          d="M2 7 C6 2, 14 2, 19 7 C24 12, 32 12, 36 7"
          stroke="#6366f1"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.3"
        />
        {/* Mid wave */}
        <path
          d="M2 13 C6 8, 14 8, 19 13 C24 18, 32 18, 36 13"
          stroke="#6366f1"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.6"
        />
        {/* Bottom wave — boldest */}
        <path
          d="M2 19 C6 14, 14 14, 19 19 C24 24, 32 24, 36 19"
          stroke="#6366f1"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>

      <span style={{
        fontFamily: 'var(--font-serif)',
        fontSize: '1.6rem',
        fontWeight: 300,
        letterSpacing: '-0.01em',
        color: 'var(--text-primary)',
        lineHeight: 1,
      }}>
        Eddy
      </span>
    </div>
  );
}
