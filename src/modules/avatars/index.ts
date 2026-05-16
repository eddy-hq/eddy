export { avatarsRouter } from './router';
export { getAvatar, saveAvatar } from './store';
export {
  DEFAULT_AVATAR,
  coerceAvatarConfig,
  isAvatarConfig,
  SKIN_TONES,
  HAIR_STYLES,
  HAIR_COLOURS,
  EYE_COLOURS,
  EXPRESSIONS,
  ACCESSORIES,
  SHIRT_COLOURS,
  SKIN_PALETTE,
  HAIR_PALETTE,
  EYE_PALETTE,
  SHIRT_PALETTE,
} from './types';
export type {
  AvatarConfig,
  SkinTone,
  HairStyle,
  HairColour,
  EyeColour,
  Expression,
  Accessory,
  ShirtColour,
} from './types';
