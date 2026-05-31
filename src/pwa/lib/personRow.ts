// Pure helpers for the player's Person row (#138). Kept out of the React
// component so the follow-state and avatar-fallback branches stay unit-testable
// in the node-env Vitest suite (no jsdom / RTL — see CLAUDE.md).

export interface FollowSubLine {
  text: string;
  followed: boolean;
}

// Sub-line under the person name: "Followed since Mar 2022" when a follow row
// exists, "Not followed" otherwise. Short month matches the design prototype's
// .vp-channel CHANNEL_META. `followed` drives the colour (teal when not).
export function followSubLine(followedAt: string | null | undefined): FollowSubLine {
  if (!followedAt) return { text: 'Not followed', followed: false };
  const d = new Date(followedAt);
  if (Number.isNaN(d.getTime())) return { text: 'Not followed', followed: false };
  const label = d.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
  return { text: `Followed since ${label}`, followed: true };
}

// First character of the display name, uppercased — the gradient-avatar glyph.
export function personInitial(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

// Deterministic gradient swatch for the photo-less fallback. Palette mirrors
// the design prototype's .vp-channel-av swatches; the choice is stable per seed
// so a creator always gets the same colour across renders.
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #5C8C5A 0%, #2F4F2D 100%)',
  'linear-gradient(135deg, #C9412C 0%, #6B1F14 100%)',
  'linear-gradient(135deg, #D9A14A 0%, #8B5A1F 100%)',
  'linear-gradient(135deg, #8B6B3F 0%, #4A3520 100%)',
  'linear-gradient(135deg, #4A6FA5 0%, #243B5E 100%)',
  'linear-gradient(135deg, #7A5C9E 0%, #3D2C57 100%)',
] as const;

export function avatarGradient(seed: string | null | undefined): string {
  const s = seed ?? '';
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % AVATAR_GRADIENTS.length;
  return AVATAR_GRADIENTS[idx];
}
