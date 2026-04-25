import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadDateToIso, daysSince, formatAge, formatDuration } from './util';

describe('uploadDateToIso', () => {
  it('converts a valid 8-char yt-dlp upload_date to ISO', () => {
    expect(uploadDateToIso('20260315')).toBe('2026-03-15T00:00:00.000Z');
  });

  it('returns null for null input', () => {
    expect(uploadDateToIso(null)).toBeNull();
  });

  it('returns null for wrong length', () => {
    expect(uploadDateToIso('2026-03-15')).toBeNull();
    expect(uploadDateToIso('202603')).toBeNull();
  });
});

describe('daysSince', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when the input is null', () => {
    expect(daysSince(null)).toBeNull();
  });

  it('floors the day diff for an older date', () => {
    expect(daysSince('2026-04-20T00:00:00.000Z')).toBe(5);
  });

  it('returns 0 for the same calendar moment', () => {
    expect(daysSince('2026-04-25T00:00:00.000Z')).toBe(0);
  });
});

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "unknown age" for null', () => {
    expect(formatAge(null)).toBe('unknown age');
  });

  it('returns "today" for <1 day', () => {
    expect(formatAge('2026-04-25T06:00:00.000Z')).toBe('today');
  });

  it('returns "yesterday" for 1 day ago', () => {
    expect(formatAge('2026-04-24T06:00:00.000Z')).toBe('yesterday');
  });

  it('returns days for <7 days', () => {
    expect(formatAge('2026-04-21T12:00:00.000Z')).toBe('4d ago');
  });

  it('returns weeks for <30 days', () => {
    expect(formatAge('2026-04-10T12:00:00.000Z')).toBe('2w ago');
  });

  it('returns months for >=30 days', () => {
    expect(formatAge('2026-01-25T12:00:00.000Z')).toBe('3mo ago');
  });
});

describe('formatDuration', () => {
  it('returns "unknown length" for null or non-positive', () => {
    expect(formatDuration(null)).toBe('unknown length');
    expect(formatDuration(0)).toBe('unknown length');
    expect(formatDuration(-30)).toBe('unknown length');
  });

  it('formats seconds under a minute', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats whole minutes under an hour', () => {
    expect(formatDuration(125)).toBe('2m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe('3h25m');
  });

  it('formats whole hours without trailing 0m', () => {
    expect(formatDuration(2 * 3600)).toBe('2h');
  });
});
