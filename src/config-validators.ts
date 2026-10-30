import { parseExpression } from 'cron-parser';

// Validators for .env values that zod can't check on shape alone. Kept out of
// config.ts so they can be tested without parsing the real environment.

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// A five-field cron pattern BullMQ will accept: parsed with the same
// cron-parser BullMQ's job scheduler uses, so a bad range or syntax fails at
// startup rather than leaving the schedule silently unregistered.
export function isFiveFieldCron(pattern: string): boolean {
  if (!/^\S+(\s+\S+){4}$/.test(pattern.trim())) return false;
  try {
    parseExpression(pattern);
    return true;
  } catch {
    return false;
  }
}

// GUARD_CALIBRATION_TAU (ADR-0017, amended 2026-10-30): a number in (0, 1], or
// 'off'. Unset or blank is the default, 0.04 — the stricter guard is the
// default, per the kid-safety rule. Returns the threshold, null for 'off', or
// undefined when the value is invalid.
export const DEFAULT_GUARD_CALIBRATION_TAU = 0.04;

export function parseCalibrationTau(value: string | undefined): number | null | undefined {
  const v = value?.trim() ?? '';
  if (v === '') return DEFAULT_GUARD_CALIBRATION_TAU;
  if (v === 'off') return null;
  // Number() rather than parseFloat: '0.04abc' is junk, not 0.04.
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return undefined;
  return n;
}
