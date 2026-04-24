import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

function PixelAvatar() {
  return (
    <svg width="34" height="34" viewBox="0 0 16 16" shapeRendering="crispEdges" style={{ borderRadius: 7, flexShrink: 0, display: 'block' }}>
      <rect width="16" height="16" fill="#281408"/>
      <rect x="2" y="2" width="12" height="11" fill="#C8845A"/>
      <rect x="2" y="2" width="12" height="2"  fill="#3A2210"/>
      <rect x="2" y="4" width="2"  height="2"  fill="#3A2210"/>
      <rect x="12" y="4" width="2" height="2"  fill="#3A2210"/>
      <rect x="4" y="6" width="2"  height="2"  fill="#180E08"/>
      <rect x="10" y="6" width="2" height="2"  fill="#180E08"/>
      <rect x="4" y="6" width="1"  height="1"  fill="#fff"/>
      <rect x="10" y="6" width="1" height="1"  fill="#fff"/>
      <rect x="7" y="8" width="2"  height="1"  fill="#A06438"/>
      <rect x="5" y="10" width="2" height="1"  fill="#3A2210"/>
      <rect x="9" y="10" width="2" height="1"  fill="#3A2210"/>
      <rect x="6" y="11" width="4" height="1"  fill="#3A2210"/>
      <rect x="1" y="6" width="1"  height="3"  fill="#C8845A"/>
      <rect x="14" y="6" width="1" height="3"  fill="#C8845A"/>
      <rect x="5" y="13" width="6" height="2"  fill="#C8845A"/>
      <rect x="3" y="15" width="10" height="1" fill="#3D6B6B"/>
    </svg>
  );
}

export function AppHeader({ borderBottom = true }: { borderBottom?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const userParam = params.get('userId')
    ? `userId=${params.get('userId')}`
    : params.get('user')
    ? `user=${params.get('user')}`
    : '';

  function goProfile() {
    navigate(userParam ? `/profile?${userParam}` : '/profile');
  }

  return (
    <div style={{
      padding: '6px 22px 0',
      borderBottom: borderBottom ? '1px solid var(--border-subtle)' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, lineHeight: 1 }}>
          <svg width="22" height="24" viewBox="4 7 40 33" fill="none" style={{ flexShrink: 0, display: 'block' }}>
            <path d="M 40 23 C 40 11,29 5,18 8 C 8 11,4 21,7 30 C 10 39,21 44,31 41 C 39 38,43 29,40 22 C 37 16,28 13,21 17 C 15 21,14 29,18 34 C 21 37,28 37,32 32" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" fill="none"/>
          </svg>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 400, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>
            eddy
          </span>
        </div>
        <button
          onClick={goProfile}
          aria-label="Profile"
          style={{
            padding: 0, background: 'none', border: 'none', cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <PixelAvatar />
        </button>
      </div>
    </div>
  );
}
