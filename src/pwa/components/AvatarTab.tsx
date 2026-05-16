import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PixelAvatar } from './PixelAvatar';
import {
  AvatarConfig,
  DEFAULT_AVATAR,
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
  HairStyle,
  HairColour,
  SkinTone,
  EyeColour,
  Expression,
  Accessory,
  ShirtColour,
} from '../../modules/avatars/types';

// ── API ──────────────────────────────────────────────────────────────────────

async function fetchAvatar(userId: string): Promise<AvatarConfig> {
  const res = await fetch(`/avatars?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('Failed to load avatar');
  const json = (await res.json()) as { avatar: AvatarConfig };
  return json.avatar;
}

async function saveAvatar(userId: string, avatar: AvatarConfig): Promise<AvatarConfig> {
  const res = await fetch('/avatars', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, avatar }),
  });
  if (!res.ok) throw new Error('Failed to save avatar');
  const json = (await res.json()) as { avatar: AvatarConfig };
  return json.avatar;
}

// ── Labels ───────────────────────────────────────────────────────────────────

const SKIN_LABEL: Record<SkinTone, string> = {
  fair: 'Fair', light: 'Light', tan: 'Tan', brown: 'Brown', dark: 'Dark',
};
const HAIR_STYLE_LABEL: Record<HairStyle, string> = {
  short: 'Short', messy: 'Messy', bowl: 'Bowl', long: 'Long',
  curly: 'Curly', mohawk: 'Mohawk', bald: 'Bald',
};
const HAIR_COLOUR_LABEL: Record<HairColour, string> = {
  blond: 'Blond', ginger: 'Ginger', brown: 'Brown', black: 'Black',
  pink: 'Pink', blue: 'Blue', mint: 'Mint',
};
const EYE_LABEL: Record<EyeColour, string> = {
  blue: 'Blue', green: 'Green', brown: 'Brown', hazel: 'Hazel', grey: 'Grey',
};
const EXPRESSION_LABEL: Record<Expression, string> = {
  smile: 'Smile', grin: 'Grin', surprise: 'Whoa', flat: 'Cool',
};
const ACCESSORY_LABEL: Record<Accessory, string> = {
  none: 'None', glasses: 'Glasses', cap: 'Cap', headphones: 'Headphones',
};
const SHIRT_LABEL: Record<ShirtColour, string> = {
  teal: 'Teal', red: 'Red', navy: 'Navy', forest: 'Forest', mustard: 'Mustard', purple: 'Purple',
};

// ── Tab ──────────────────────────────────────────────────────────────────────

export function AvatarTab({ userId }: { userId: string }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['avatar', userId],
    queryFn: () => fetchAvatar(userId),
    enabled: !!userId,
  });

  const mutation = useMutation({
    mutationFn: (next: AvatarConfig) => saveAvatar(userId, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ['avatar', userId] });
      const previous = queryClient.getQueryData<AvatarConfig>(['avatar', userId]);
      queryClient.setQueryData(['avatar', userId], next);
      return { previous };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['avatar', userId], ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['avatar', userId] });
    },
  });

  const current = data ?? DEFAULT_AVATAR;

  function update<K extends keyof AvatarConfig>(key: K, value: AvatarConfig[K]) {
    if (current[key] === value) return;
    mutation.mutate({ ...current, [key]: value });
  }

  if (isLoading) {
    return (
      <p style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '24px 22px 0', margin: 0 }}>
        Loading…
      </p>
    );
  }

  return (
    <>
      <Preview config={current} />

      <PickerSection title="Skin">
        <SwatchRow>
          {SKIN_TONES.map((tone) => (
            <ColourTile
              key={tone}
              colour={SKIN_PALETTE[tone].base}
              label={SKIN_LABEL[tone]}
              selected={current.skin === tone}
              onClick={() => update('skin', tone)}
            />
          ))}
        </SwatchRow>
      </PickerSection>

      <PickerSection title="Hair style">
        <PreviewRow>
          {HAIR_STYLES.map((style) => (
            <PreviewTile
              key={style}
              label={HAIR_STYLE_LABEL[style]}
              selected={current.hairStyle === style}
              onClick={() => update('hairStyle', style)}
              config={{ ...current, hairStyle: style, accessory: 'none' }}
            />
          ))}
        </PreviewRow>
      </PickerSection>

      <PickerSection title="Hair colour">
        <SwatchRow>
          {HAIR_COLOURS.map((c) => (
            <ColourTile
              key={c}
              colour={HAIR_PALETTE[c].base}
              label={HAIR_COLOUR_LABEL[c]}
              selected={current.hairColour === c}
              onClick={() => update('hairColour', c)}
            />
          ))}
        </SwatchRow>
      </PickerSection>

      <PickerSection title="Eyes">
        <SwatchRow>
          {EYE_COLOURS.map((c) => (
            <ColourTile
              key={c}
              colour={EYE_PALETTE[c]}
              label={EYE_LABEL[c]}
              selected={current.eyeColour === c}
              onClick={() => update('eyeColour', c)}
            />
          ))}
        </SwatchRow>
      </PickerSection>

      <PickerSection title="Mood">
        <PreviewRow>
          {EXPRESSIONS.map((e) => (
            <PreviewTile
              key={e}
              label={EXPRESSION_LABEL[e]}
              selected={current.expression === e}
              onClick={() => update('expression', e)}
              config={{ ...current, expression: e }}
            />
          ))}
        </PreviewRow>
      </PickerSection>

      <PickerSection title="Accessory">
        <PreviewRow>
          {ACCESSORIES.map((a) => (
            <PreviewTile
              key={a}
              label={ACCESSORY_LABEL[a]}
              selected={current.accessory === a}
              onClick={() => update('accessory', a)}
              config={{ ...current, accessory: a }}
            />
          ))}
        </PreviewRow>
      </PickerSection>

      <PickerSection title="Shirt">
        <SwatchRow>
          {SHIRT_COLOURS.map((c) => (
            <ColourTile
              key={c}
              colour={SHIRT_PALETTE[c]}
              label={SHIRT_LABEL[c]}
              selected={current.shirt === c}
              onClick={() => update('shirt', c)}
            />
          ))}
        </SwatchRow>
      </PickerSection>
    </>
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

function Preview({ config }: { config: AvatarConfig }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 0 8px',
    }}>
      <div style={{
        background: 'var(--bg-elevated)',
        borderRadius: 28,
        padding: 18,
        boxShadow: 'var(--shadow-card)',
      }}>
        <PixelAvatar config={config} size={160} rounded background="transparent" />
      </div>
    </div>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

function PickerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '20px 0 4px' }}>
      <h2 style={{
        fontFamily: 'var(--font-serif)',
        fontSize: 15, fontWeight: 500, letterSpacing: '-0.003em',
        color: 'var(--text-primary)',
        margin: 0,
        padding: '0 22px 10px',
      }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function SwatchRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: 10,
      overflowX: 'auto',
      padding: '4px 22px 14px',
      WebkitOverflowScrolling: 'touch',
      scrollbarWidth: 'none',
    }}>
      {children}
    </div>
  );
}

function PreviewRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: 10,
      overflowX: 'auto',
      padding: '4px 22px 14px',
      WebkitOverflowScrolling: 'touch',
      scrollbarWidth: 'none',
    }}>
      {children}
    </div>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function ColourTile({
  colour, label, selected, onClick,
}: {
  colour: string; label: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      style={{
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{
        width: 48, height: 48, borderRadius: '50%',
        background: colour,
        boxShadow: selected
          ? '0 0 0 3px var(--accent), 0 0 0 5px var(--bg-primary)'
          : 'inset 0 0 0 1px rgba(0,0,0,0.08)',
        transition: 'box-shadow 150ms ease',
      }} />
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '0.01em',
        color: selected ? 'var(--accent)' : 'var(--text-tertiary)',
      }}>
        {label}
      </span>
    </button>
  );
}

function PreviewTile({
  config, label, selected, onClick,
}: {
  config: AvatarConfig; label: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      style={{
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{
        width: 64, height: 64,
        borderRadius: 16,
        background: 'var(--bg-elevated)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: selected
          ? '0 0 0 3px var(--accent), 0 0 0 5px var(--bg-primary)'
          : 'inset 0 0 0 1px var(--border-subtle)',
        transition: 'box-shadow 150ms ease',
      }}>
        <PixelAvatar config={config} size={52} rounded={false} background="transparent" />
      </span>
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '0.01em',
        color: selected ? 'var(--accent)' : 'var(--text-tertiary)',
      }}>
        {label}
      </span>
    </button>
  );
}
