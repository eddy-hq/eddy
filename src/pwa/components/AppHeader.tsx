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
          <PixelAvatar config={data ?? DEFAULT_AVATAR} size={34} rounded />
        </button>
      </div>
    </div>
  );
}
