// Pure helpers for the Decisions queue.

export type SubjectType = 'candidate' | 'request';
export type DecisionSource = 'escalation' | 'spot_check' | 'catch_up';
export type HumanVerdict = 'clear_yes' | 'clear_no';

// Daily queue (brief §17, Phase 6a): ~15 cards, escalations first; 5 spot
// checks a day, 4 clear-yes and 1 clear-no, drawn from the last 7 days.
// Escalations older than 14 days wait for catch-up mode.
export const DAILY_CARD_CAP = 15;
export const CATCH_UP_PAGE = 20;
export const SPOT_CHECK_MIX = { clear_yes: 4, clear_no: 1 } as const;
export const CATCH_UP_BATCH_MIX = { clear_yes: 8, clear_no: 2 } as const;
export const SPOT_CHECK_WINDOW_DAYS = 7;
export const ESCALATION_RECENT_DAYS = 14;

export const PARENT_BLOCKED_REASON = 'Blocked by a parent';

// Reason chips: the parent's optional why, attached to a decision. Dimension
// keys are the rubric's scored dimensions (validated at the route); the note
// is capped so a decision stays a tap, not an essay.
export const REASON_TEXT_MAX = 280;

export interface DecisionReason {
  dimensions: string[];
  text: string | null;
}

// Stored form: NULL columns when nothing was given; dimensions deduplicated
// and kept in the order supplied (the PWA sends rubric order).
export function reasonColumns(reason: DecisionReason | null | undefined): {
  dimensionsJson: string | null;
  text: string | null;
} {
  const dims = [...new Set(reason?.dimensions ?? [])];
  const text = reason?.text?.trim() || null;
  return {
    dimensionsJson: dims.length > 0 ? JSON.stringify(dims) : null,
    text,
  };
}

// UTC calendar day of an instant, as the guard_spot_checks key.
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

// FNV-1a, for turning a draw key into a PRNG seed.
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, deterministic.
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Up to `n` items drawn without replacement, independent of input order: the
// input is sorted by key, then shuffled with `rand`.
export function drawSample<T>(items: readonly T[], n: number, key: (t: T) => string, rand: () => number): T[] {
  const list = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list.slice(0, Math.max(0, n));
}

// Cards group the subjects that share a video within one source, so a video
// pending for both kids is one card ("same for both").
export function groupKey(source: DecisionSource, youtubeId: string | null, url: string): string {
  return `${source}:${youtubeId ?? url}`;
}

export function groupBy<T>(items: readonly T[], key: (t: T) => string): T[][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return [...map.values()];
}
