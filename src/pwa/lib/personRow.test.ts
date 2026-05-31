import { describe, it, expect } from 'vitest';
import { followSubLine, personInitial, avatarGradient } from './personRow';

describe('followSubLine', () => {
  it('renders "Followed since {Mon YYYY}" with short month when a follow date exists', () => {
    expect(followSubLine('2022-03-15T10:00:00.000Z')).toEqual({
      text: 'Followed since Mar 2022',
      followed: true,
    });
  });

  it('renders "Not followed" when followedAt is null/undefined', () => {
    expect(followSubLine(null)).toEqual({ text: 'Not followed', followed: false });
    expect(followSubLine(undefined)).toEqual({ text: 'Not followed', followed: false });
  });

  it('falls back to "Not followed" for an unparseable date rather than "Invalid Date"', () => {
    expect(followSubLine('not-a-date')).toEqual({ text: 'Not followed', followed: false });
  });
});

describe('personInitial', () => {
  it('returns the uppercased first character of the name', () => {
    expect(personInitial('hermitcraft')).toBe('H');
    expect(personInitial('Veritasium')).toBe('V');
  });

  it('trims leading whitespace before taking the initial', () => {
    expect(personInitial('  acoup')).toBe('A');
  });

  it('returns "?" for empty/blank/missing names', () => {
    expect(personInitial('')).toBe('?');
    expect(personInitial('   ')).toBe('?');
    expect(personInitial(null)).toBe('?');
  });
});

describe('avatarGradient', () => {
  it('returns a CSS linear-gradient string', () => {
    expect(avatarGradient('LaLiga')).toMatch(/^linear-gradient\(/);
  });

  it('is deterministic — same seed always yields the same swatch', () => {
    expect(avatarGradient('Veritasium')).toBe(avatarGradient('Veritasium'));
  });

  it('handles empty/missing seeds without throwing', () => {
    expect(avatarGradient('')).toMatch(/^linear-gradient\(/);
    expect(avatarGradient(null)).toMatch(/^linear-gradient\(/);
  });
});
