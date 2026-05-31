import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { usePersonSummary } from '../hooks/usePersonSummary';
import { followSubLine, personInitial, avatarGradient } from '../lib/personRow';

// Player-sheet Person row (#138). Replaces the old channel-name button: a
// circular avatar (captured photo, else a gradient swatch with the initial),
// the person name, and a "Followed since {Mon YYYY}" / "Not followed" sub-line.
// Tapping navigates to the person view; for a channel with no Person row yet
// the parent's resolve-on-tap creates one (recovery path preserved).
//
// Per ADR-0007 the subscription unit is the Person, so follow state comes from
// followed_people via /people/by-channel — not a channel table. The row renders
// for any resolvable channel (channelId + name, gated by the parent): it shows
// the channel name + gradient + "Not followed" immediately, then enriches with
// the captured photo and real follow date once the lookup resolves. A 404 (no
// Person row yet) keeps the not-followed fallback rather than hiding the row.
export function PersonRow({
  userId,
  channel,
  channelId,
  onTap,
}: {
  userId: string;
  channel: string;
  channelId: string;
  onTap: () => void;
}) {
  const { data } = usePersonSummary(userId, channelId);
  const name = data?.displayName ?? channel;
  const sub = followSubLine(data?.followedAt);

  return (
    <button
      onClick={onTap}
      style={{
        display: 'flex', alignItems: 'center', gap: 11,
        width: '100%', marginLeft: -2, marginBottom: 12,
        padding: '8px 8px 8px 6px',
        background: 'none', border: 0, borderRadius: 10,
        textAlign: 'left', fontFamily: 'inherit', color: 'inherit',
        cursor: 'pointer', minHeight: 36,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Avatar photoUrl={data?.photoUrl ?? null} name={name} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{
          fontWeight: 600, fontSize: 14, letterSpacing: '-0.005em',
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {name}
        </span>
        <span style={{
          fontSize: 11.5, fontWeight: 500, letterSpacing: '0.01em',
          color: sub.followed ? 'var(--text-secondary)' : 'var(--teal)',
        }}>
          {sub.text}
        </span>
      </span>
      <ChevronRight size={18} strokeWidth={2} aria-hidden style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
    </button>
  );
}

// 34×34 circular avatar: the captured photo when present, otherwise a
// deterministic gradient swatch carrying the person's initial. Falls back to
// the gradient if the photo fails to load.
function Avatar({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  const [errored, setErrored] = useState(false);
  const showImage = photoUrl && !errored;

  const base: React.CSSProperties = {
    width: 34, height: 34, borderRadius: '50%',
    flexShrink: 0, overflow: 'hidden',
    border: '1px solid rgba(26,25,22,0.06)',
  };

  if (showImage) {
    return (
      <span style={{ ...base, display: 'block', background: 'var(--bg-surface)' }}>
        <img
          src={photoUrl}
          alt={name}
          onError={() => setErrored(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      style={{
        ...base,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: avatarGradient(name),
        color: 'rgba(255,255,255,0.92)',
        fontWeight: 600, fontSize: 15,
      }}
    >
      {personInitial(name)}
    </span>
  );
}
