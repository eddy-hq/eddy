// Shape + palettes for the customisable pixel avatar. Shared between the
// server (validates writes to users.profile.avatar) and the PWA (renders
// the SVG). Adding a new option = extend the enum + extend the palette;
// the renderer falls back to defaults for unknown values.

export const SKIN_TONES = ['fair', 'light', 'tan', 'brown', 'dark'] as const;
export const HAIR_STYLES = ['short', 'messy', 'bowl', 'long', 'curly', 'mohawk', 'bald'] as const;
export const HAIR_COLOURS = ['blond', 'ginger', 'brown', 'black', 'pink', 'blue', 'mint'] as const;
export const EYE_COLOURS = ['blue', 'green', 'brown', 'hazel', 'grey'] as const;
export const EXPRESSIONS = ['smile', 'grin', 'surprise', 'flat'] as const;
export const ACCESSORIES = ['none', 'glasses', 'cap', 'headphones'] as const;
export const SHIRT_COLOURS = ['teal', 'red', 'navy', 'forest', 'mustard', 'purple'] as const;

export type SkinTone = (typeof SKIN_TONES)[number];
export type HairStyle = (typeof HAIR_STYLES)[number];
export type HairColour = (typeof HAIR_COLOURS)[number];
export type EyeColour = (typeof EYE_COLOURS)[number];
export type Expression = (typeof EXPRESSIONS)[number];
export type Accessory = (typeof ACCESSORIES)[number];
export type ShirtColour = (typeof SHIRT_COLOURS)[number];

export interface AvatarConfig {
  skin: SkinTone;
  hairStyle: HairStyle;
  hairColour: HairColour;
  eyeColour: EyeColour;
  expression: Expression;
  accessory: Accessory;
  shirt: ShirtColour;
}

export const DEFAULT_AVATAR: AvatarConfig = {
  skin: 'light',
  hairStyle: 'short',
  hairColour: 'blond',
  eyeColour: 'blue',
  expression: 'smile',
  accessory: 'none',
  shirt: 'teal',
};

export const SKIN_PALETTE: Record<SkinTone, { base: string; shade: string; blush: string }> = {
  fair:  { base: '#F5DCBE', shade: '#E8C49C', blush: '#E0A48C' },
  light: { base: '#F0C8A0', shade: '#E0B488', blush: '#C68A50' },
  tan:   { base: '#D4A175', shade: '#B88455', blush: '#A06438' },
  brown: { base: '#A07050', shade: '#7A5238', blush: '#5C3818' },
  dark:  { base: '#5C3A22', shade: '#3A2410', blush: '#2A180A' },
};

export const HAIR_PALETTE: Record<HairColour, { base: string; shade: string }> = {
  blond:  { base: '#C9A05A', shade: '#A87E3C' },
  ginger: { base: '#C8542A', shade: '#9C3818' },
  brown:  { base: '#6A4828', shade: '#4A3018' },
  black:  { base: '#1E1612', shade: '#3A2A22' },
  pink:   { base: '#E26FA8', shade: '#B84A82' },
  blue:   { base: '#3D6BA0', shade: '#27508A' },
  mint:   { base: '#5BBCA0', shade: '#3A8E76' },
};

export const EYE_PALETTE: Record<EyeColour, string> = {
  blue:  '#3A6E8A',
  green: '#4A7A40',
  brown: '#5A4A2A',
  hazel: '#A07840',
  grey:  '#6B7080',
};

export const SHIRT_PALETTE: Record<ShirtColour, string> = {
  teal:    '#3D6B6B',
  red:     '#B8543C',
  navy:    '#2A4D6A',
  forest:  '#3A6E4A',
  mustard: '#C8A040',
  purple:  '#7A4C8A',
};

export function isAvatarConfig(value: unknown): value is AvatarConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (SKIN_TONES as readonly string[]).includes(v.skin as string) &&
    (HAIR_STYLES as readonly string[]).includes(v.hairStyle as string) &&
    (HAIR_COLOURS as readonly string[]).includes(v.hairColour as string) &&
    (EYE_COLOURS as readonly string[]).includes(v.eyeColour as string) &&
    (EXPRESSIONS as readonly string[]).includes(v.expression as string) &&
    (ACCESSORIES as readonly string[]).includes(v.accessory as string) &&
    (SHIRT_COLOURS as readonly string[]).includes(v.shirt as string)
  );
}

export function coerceAvatarConfig(value: unknown): AvatarConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_AVATAR };
  const v = value as Record<string, unknown>;
  return {
    skin:       (SKIN_TONES as readonly string[]).includes(v.skin as string)             ? (v.skin as SkinTone)         : DEFAULT_AVATAR.skin,
    hairStyle:  (HAIR_STYLES as readonly string[]).includes(v.hairStyle as string)       ? (v.hairStyle as HairStyle)   : DEFAULT_AVATAR.hairStyle,
    hairColour: (HAIR_COLOURS as readonly string[]).includes(v.hairColour as string)     ? (v.hairColour as HairColour) : DEFAULT_AVATAR.hairColour,
    eyeColour:  (EYE_COLOURS as readonly string[]).includes(v.eyeColour as string)       ? (v.eyeColour as EyeColour)   : DEFAULT_AVATAR.eyeColour,
    expression: (EXPRESSIONS as readonly string[]).includes(v.expression as string)      ? (v.expression as Expression) : DEFAULT_AVATAR.expression,
    accessory:  (ACCESSORIES as readonly string[]).includes(v.accessory as string)       ? (v.accessory as Accessory)   : DEFAULT_AVATAR.accessory,
    shirt:      (SHIRT_COLOURS as readonly string[]).includes(v.shirt as string)         ? (v.shirt as ShirtColour)     : DEFAULT_AVATAR.shirt,
  };
}
