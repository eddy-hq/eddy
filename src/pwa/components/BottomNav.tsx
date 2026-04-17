import React from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const userParam = params.get('userId')
    ? `userId=${params.get('userId')}`
    : params.get('user')
    ? `user=${params.get('user')}`
    : '';

  const isFeed  = location.pathname === '/feed';
  const isSaved = location.pathname === '/saved';

  function goTo(path: string) {
    navigate(userParam ? `${path}?${userParam}` : path);
  }

  const tabStyle: React.CSSProperties = {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: 4, paddingTop: 6,
    background: 'none', border: 'none', cursor: 'pointer',
  };

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, height: 84,
      backdropFilter: 'blur(22px)', WebkitBackdropFilter: 'blur(22px)',
      borderTop: '1px solid var(--border-subtle)',
      display: 'flex', alignItems: 'flex-start', paddingTop: 10,
      zIndex: 20, background: 'var(--nav-bg)',
    }}>
      <button onClick={() => goTo('/feed')} style={tabStyle} aria-label="Feed">
        <span style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isFeed ? 'var(--accent)' : 'var(--text-tertiary)' }}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect x="3" y="4"  width="16" height="3" rx="1" fill="currentColor"/>
            <rect x="3" y="10" width="16" height="3" rx="1" fill="currentColor"/>
            <rect x="3" y="16" width="10" height="3" rx="1" fill="currentColor"/>
          </svg>
        </span>
        <span style={{ fontSize: 10, fontWeight: isFeed ? 600 : 500, color: isFeed ? 'var(--accent)' : 'var(--text-tertiary)', letterSpacing: '0.02em' }}>
          Feed
        </span>
      </button>

      <button onClick={() => goTo('/saved')} style={tabStyle} aria-label="Saved">
        <span style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isSaved ? 'var(--accent)' : 'var(--text-tertiary)' }}>
          <svg width="22" height="22" viewBox="0 0 22 22"
            fill={isSaved ? 'currentColor' : 'none'}
            stroke={isSaved ? 'none' : 'currentColor'}
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3h12a1 1 0 011 1v15l-6.5-3.5L5 19V4a1 1 0 011-1z"/>
          </svg>
        </span>
        <span style={{ fontSize: 10, fontWeight: isSaved ? 600 : 500, color: isSaved ? 'var(--accent)' : 'var(--text-tertiary)', letterSpacing: '0.02em' }}>
          Saved
        </span>
      </button>
    </nav>
  );
}
