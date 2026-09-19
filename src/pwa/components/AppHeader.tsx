import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PixelAvatar } from './PixelAvatar';
import { AvatarConfig, DEFAULT_AVATAR } from '../../modules/avatars/types';

async function fetchAvatar(userId: string): Promise<AvatarConfig> {
  const res = await fetch(`/avatars?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load avatar');
  const json = (await res.json()) as { avatar: AvatarConfig };
  return json.avatar;
}

export function AppHeader({ borderBottom = true }: { borderBottom?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? params.get('user') ?? '';
  const userParam = params.get('userId')
    ? `userId=${params.get('userId')}`
    : params.get('user')
    ? `user=${params.get('user')}`
    : '';

  // Shared cache key with AvatarTab so a save on /profile re-renders the
  // header avatar without a refetch.
  const { data } = useQuery({
    queryKey: ['avatar', userId],
    queryFn: () => fetchAvatar(userId),
    enabled: !!userId,
    staleTime: 60_000,
  });

  function goProfile() {
    navigate(userParam ? `/profile?${userParam}` : '/profile');
  }

  return (
    <div style={{
      padding: '6px 22px 0',
      borderBottom: borderBottom ? '1px solid var(--border-subtle)' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1 }}>
          {/* The iOS icon's banded play mark, cut down to three bands so it
              holds at 26px, in the accent rather than the icon's navy. The
              full-colour source is design/icon/AppIcon.svg. */}
          <svg width="26" height="26" viewBox="0 0 512 512" aria-hidden style={{ flexShrink: 0, display: 'block' }}>
            <rect width="512" height="512" rx="150" fill="var(--accent)" opacity="0.2" />
            <rect x="60" y="60" width="392" height="392" rx="115" fill="var(--accent)" opacity="0.4" />
            <rect x="120" y="120" width="272" height="272" rx="80" fill="var(--accent)" />
            <path d="M 225 205 L 225 307 L 311 256 Z" fill="var(--bg-primary)" stroke="var(--bg-primary)" strokeWidth="21" strokeLinejoin="round" />
          </svg>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
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
          <PixelAvatar config={data ?? DEFAULT_AVATAR} size={34} rounded />
        </button>
      </div>
    </div>
  );
}
