import React from 'react';
import {
  AvatarConfig,
  DEFAULT_AVATAR,
  SKIN_PALETTE,
  HAIR_PALETTE,
  EYE_PALETTE,
  SHIRT_PALETTE,
  HairStyle,
  Expression,
  Accessory,
} from '../../modules/avatars/types';

// 16x16 pixel-grid avatar in the style of design/no-bg/eddy-avatar-*.svg.
// Each piece is a list of <rect> primitives; the renderer assembles them in
// z-order so accessories can sit above hair and eyes.

interface Pixel { x: number; y: number; w: number; h: number; fill: string }

interface RenderInputs {
  config: AvatarConfig;
  skin: { base: string; shade: string; blush: string };
  hair: { base: string; shade: string };
  eye: string;
  shirt: string;
}

function headPixels({ skin }: RenderInputs): Pixel[] {
  return [
    { x: 3, y: 4,  w: 10, h: 9, fill: skin.base },
    { x: 3, y: 12, w: 10, h: 1, fill: skin.shade },
    { x: 2, y: 7,  w: 1,  h: 2, fill: skin.base },
    { x: 13, y: 7, w: 1,  h: 2, fill: skin.base },
    { x: 5, y: 13, w: 6,  h: 2, fill: skin.base },
  ];
}

function shirtPixels({ shirt }: RenderInputs): Pixel[] {
  return [{ x: 3, y: 15, w: 10, h: 1, fill: shirt }];
}

function cheekPixels({ skin }: RenderInputs): Pixel[] {
  return [
    { x: 5,  y: 10, w: 1, h: 1, fill: skin.blush },
    { x: 10, y: 10, w: 1, h: 1, fill: skin.blush },
  ];
}

function hairPixels(style: HairStyle, hair: { base: string; shade: string }): Pixel[] {
  const b = hair.base;
  const s = hair.shade;
  switch (style) {
    case 'bald':
      return [];
    case 'short':
      return [
        { x: 3,  y: 2, w: 10, h: 3, fill: b },
        { x: 2,  y: 3, w: 1,  h: 3, fill: b },
        { x: 13, y: 3, w: 1,  h: 3, fill: b },
        { x: 6,  y: 3, w: 3,  h: 1, fill: s },
        { x: 9,  y: 2, w: 1,  h: 2, fill: s },
      ];
    case 'messy':
      return [
        { x: 3,  y: 2, w: 10, h: 2, fill: b },
        { x: 2,  y: 3, w: 1,  h: 3, fill: b },
        { x: 13, y: 3, w: 1,  h: 3, fill: b },
        { x: 4,  y: 1, w: 2,  h: 1, fill: b },
        { x: 7,  y: 1, w: 2,  h: 1, fill: b },
        { x: 10, y: 1, w: 2,  h: 1, fill: b },
        { x: 3,  y: 3, w: 2,  h: 1, fill: s },
        { x: 8,  y: 2, w: 2,  h: 1, fill: s },
        { x: 11, y: 3, w: 2,  h: 1, fill: s },
      ];
    case 'bowl':
      return [
        { x: 3,  y: 2, w: 10, h: 3, fill: b },
        { x: 2,  y: 3, w: 1,  h: 3, fill: b },
        { x: 13, y: 3, w: 1,  h: 3, fill: b },
        { x: 4,  y: 5, w: 8,  h: 1, fill: b },
        { x: 5,  y: 3, w: 2,  h: 1, fill: s },
        { x: 9,  y: 3, w: 2,  h: 1, fill: s },
      ];
    case 'long':
      return [
        { x: 3,  y: 2,  w: 10, h: 3, fill: b },
        { x: 2,  y: 3,  w: 1,  h: 4, fill: b },
        { x: 13, y: 3,  w: 1,  h: 4, fill: b },
        { x: 2,  y: 9,  w: 1,  h: 4, fill: b },
        { x: 13, y: 9,  w: 1,  h: 4, fill: b },
        { x: 6,  y: 3,  w: 3,  h: 1, fill: s },
        { x: 2,  y: 11, w: 1,  h: 2, fill: s },
        { x: 13, y: 11, w: 1,  h: 2, fill: s },
      ];
    case 'curly':
      return [
        { x: 3,  y: 3, w: 10, h: 3, fill: b },
        { x: 2,  y: 4, w: 1,  h: 3, fill: b },
        { x: 13, y: 4, w: 1,  h: 3, fill: b },
        // bumpy top edge — alternating pixels
        { x: 3,  y: 2, w: 2,  h: 1, fill: b },
        { x: 6,  y: 2, w: 1,  h: 1, fill: b },
        { x: 8,  y: 2, w: 2,  h: 1, fill: b },
        { x: 11, y: 2, w: 1,  h: 1, fill: b },
        { x: 12, y: 2, w: 1,  h: 1, fill: b },
        { x: 4,  y: 1, w: 1,  h: 1, fill: b },
        { x: 7,  y: 1, w: 1,  h: 1, fill: b },
        { x: 10, y: 1, w: 1,  h: 1, fill: b },
        // shade dots
        { x: 5,  y: 4, w: 1,  h: 1, fill: s },
        { x: 9,  y: 4, w: 1,  h: 1, fill: s },
        { x: 11, y: 5, w: 1,  h: 1, fill: s },
      ];
    case 'mohawk':
      return [
        { x: 7,  y: 1, w: 2,  h: 5, fill: b },
        { x: 6,  y: 2, w: 1,  h: 1, fill: b },
        { x: 9,  y: 2, w: 1,  h: 1, fill: b },
        { x: 8,  y: 1, w: 1,  h: 1, fill: s },
        { x: 7,  y: 3, w: 1,  h: 2, fill: s },
      ];
  }
}

function eyePixels({ config, eye }: RenderInputs): Pixel[] {
  // Surprised: round, two-tall dark eyes — no sclera. Else: white sclera +
  // pupil offset, with glasses lowering pupil into the frame.
  if (config.expression === 'surprise') {
    return [
      { x: 5,  y: 7, w: 2, h: 2, fill: '#1A1612' },
      { x: 9,  y: 7, w: 2, h: 2, fill: '#1A1612' },
      { x: 5,  y: 7, w: 1, h: 1, fill: '#FFFFFF' },
      { x: 9,  y: 7, w: 1, h: 1, fill: '#FFFFFF' },
    ];
  }
  // With glasses, the right column of each sclera (x=6 / x=11) is the frame
  // vertical, so place pupils in the column the frame leaves visible.
  const glasses = config.accessory === 'glasses';
  const pupilY = glasses ? 8 : 7;
  const leftPupilX = glasses ? 5 : 6;
  const rightPupilX = 10;
  return [
    { x: 5, y: 7, w: 2, h: 2, fill: '#FFFFFF' },
    { x: 9, y: 7, w: 2, h: 2, fill: '#FFFFFF' },
    { x: leftPupilX,  y: pupilY, w: 1, h: 1, fill: eye },
    { x: rightPupilX, y: pupilY, w: 1, h: 1, fill: eye },
  ];
}

function mouthPixels(expression: Expression, skin: { shade: string; blush: string }): Pixel[] {
  switch (expression) {
    case 'smile':
      return [{ x: 7, y: 11, w: 2, h: 1, fill: '#C8745A' }];
    case 'grin':
      return [
        { x: 6, y: 11, w: 4, h: 1, fill: '#3A2210' },
        { x: 7, y: 11, w: 2, h: 1, fill: '#F4F1EA' },
      ];
    case 'surprise':
      return [{ x: 7, y: 11, w: 2, h: 1, fill: '#3A2210' }];
    case 'flat':
      return [{ x: 6, y: 11, w: 4, h: 1, fill: skin.shade }];
  }
}

function nosePixels({ skin }: RenderInputs): Pixel[] {
  return [{ x: 8, y: 10, w: 1, h: 1, fill: skin.shade }];
}

function accessoryPixels(accessory: Accessory): Pixel[] {
  switch (accessory) {
    case 'none':
      return [];
    case 'glasses':
      return [
        // top bar of frames
        { x: 4, y: 6,  w: 3, h: 1, fill: '#1A1612' },
        { x: 9, y: 6,  w: 3, h: 1, fill: '#1A1612' },
        // bottom bar
        { x: 4, y: 10, w: 3, h: 1, fill: '#1A1612' },
        { x: 9, y: 10, w: 3, h: 1, fill: '#1A1612' },
        // left / right verticals + bridge
        { x: 4,  y: 6, w: 1, h: 5, fill: '#1A1612' },
        { x: 6,  y: 6, w: 1, h: 5, fill: '#1A1612' },
        { x: 9,  y: 6, w: 1, h: 5, fill: '#1A1612' },
        { x: 11, y: 6, w: 1, h: 5, fill: '#1A1612' },
        { x: 7,  y: 8, w: 2, h: 1, fill: '#1A1612' },
      ];
    case 'cap':
      return [
        // crown
        { x: 2, y: 2, w: 12, h: 3, fill: '#C84838' },
        { x: 2, y: 2, w: 12, h: 1, fill: '#9C2818' },
        { x: 3, y: 1, w: 10, h: 1, fill: '#C84838' },
      ];
    case 'headphones':
      return [
        // headband
        { x: 3, y: 1, w: 10, h: 1, fill: '#2A4D6A' },
        { x: 2, y: 2, w: 1,  h: 1, fill: '#2A4D6A' },
        { x: 13, y: 2, w: 1, h: 1, fill: '#2A4D6A' },
        // ear cups
        { x: 1, y: 6, w: 2, h: 3, fill: '#2A4D6A' },
        { x: 13, y: 6, w: 2, h: 3, fill: '#2A4D6A' },
        // cup highlights
        { x: 1,  y: 7, w: 1, h: 1, fill: '#5A8AAC' },
        { x: 14, y: 7, w: 1, h: 1, fill: '#5A8AAC' },
      ];
  }
}

function capBrimPixels(): Pixel[] {
  return [
    // visor sticks out at row 4 across the whole face
    { x: 3, y: 4, w: 10, h: 1, fill: '#9C2818' },
    // shadow under brim
    { x: 4, y: 5, w: 8,  h: 1, fill: '#C84838' },
  ];
}

function capTemplesPixels(hair: { base: string; shade: string }): Pixel[] {
  // Hair peeking out at the temples below the brim — visible at the head
  // sides on rows 6-7 so the chosen hair colour still reads.
  return [
    { x: 2,  y: 6, w: 1, h: 1, fill: hair.base },
    { x: 13, y: 6, w: 1, h: 1, fill: hair.base },
    { x: 3,  y: 6, w: 1, h: 1, fill: hair.shade },
    { x: 12, y: 6, w: 1, h: 1, fill: hair.shade },
  ];
}

function buildPixels(config: AvatarConfig): Pixel[] {
  const inputs: RenderInputs = {
    config,
    skin: SKIN_PALETTE[config.skin],
    hair: HAIR_PALETTE[config.hairColour],
    eye: EYE_PALETTE[config.eyeColour],
    shirt: SHIRT_PALETTE[config.shirt],
  };

  const pixels: Pixel[] = [];
  pixels.push(...headPixels(inputs));
  pixels.push(...shirtPixels(inputs));

  // Hair sits between head and accessories. A cap covers the crown — we
  // peek hair colour at the temples instead so colour still reads.
  if (config.accessory !== 'cap') {
    pixels.push(...hairPixels(config.hairStyle, inputs.hair));
  }

  pixels.push(...eyePixels(inputs));
  pixels.push(...nosePixels(inputs));
  pixels.push(...cheekPixels(inputs));
  pixels.push(...mouthPixels(config.expression, inputs.skin));

  if (config.accessory === 'cap') {
    pixels.push(...accessoryPixels('cap'));
    pixels.push(...capBrimPixels());
    if (config.hairStyle !== 'bald') pixels.push(...capTemplesPixels(inputs.hair));
  } else if (config.accessory !== 'none') {
    pixels.push(...accessoryPixels(config.accessory));
  }

  return pixels;
}

export interface PixelAvatarProps {
  config?: AvatarConfig;
  size?: number;
  rounded?: boolean;
  background?: string;
  title?: string;
}

export function PixelAvatar({
  config = DEFAULT_AVATAR,
  size = 64,
  rounded = true,
  background,
  title,
}: PixelAvatarProps) {
  const pixels = buildPixels(config);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      style={{
        borderRadius: rounded ? Math.round(size * 0.22) : 0,
        flexShrink: 0,
        display: 'block',
        background: background ?? 'transparent',
      }}
    >
      {pixels.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill={p.fill} />
      ))}
    </svg>
  );
}
