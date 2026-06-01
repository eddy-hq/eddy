import { describe, it, expect } from 'vitest';
import { relativeTimeAgo } from './relativeTime';

// Fixed "now" so every case is deterministic without mocking Date.
const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

describe('relativeTimeAgo', () => {
  it('reads sub-minute and future timestamps as "just now"', () => {
    expect(relativeTimeAgo(ago(0), NOW)).toBe('just now');
    expect(relativeTimeAgo(ago(30_000), NOW)).toBe('just now');
    // Clock skew: a timestamp slightly ahead of `now` must not go negative.
    expect(relativeTimeAgo(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('just now');
  });

  it('formats minutes, hours and days below a week', () => {
    expect(relativeTimeAgo(ago(5 * MINUTE), NOW)).toBe('5m ago');
    expect(relativeTimeAgo(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(relativeTimeAgo(ago(2 * DAY), NOW)).toBe('2d ago');
    expect(relativeTimeAgo(ago(6 * DAY), NOW)).toBe('6d ago');
  });

  it('widens to weeks between 7 and 29 days', () => {
    expect(relativeTimeAgo(ago(WEEK), NOW)).toBe('1w ago');
    expect(relativeTimeAgo(ago(3 * WEEK), NOW)).toBe('3w ago');
    expect(relativeTimeAgo(ago(29 * DAY), NOW)).toBe('4w ago');
  });

  it('widens to months between 30 and 364 days', () => {
    expect(relativeTimeAgo(ago(MONTH), NOW)).toBe('1mo ago');
    expect(relativeTimeAgo(ago(6 * MONTH), NOW)).toBe('6mo ago');
    expect(relativeTimeAgo(ago(364 * DAY), NOW)).toBe('12mo ago');
  });

  it('widens to years past a year — no more "1278d ago"', () => {
    expect(relativeTimeAgo(ago(YEAR), NOW)).toBe('1y ago');
    expect(relativeTimeAgo(ago(3 * YEAR), NOW)).toBe('3y ago');
    // 1278 days ≈ 3.5 years — the case the issue calls out.
    expect(relativeTimeAgo(ago(1278 * DAY), NOW)).toBe('3y ago');
  });

  it('returns an empty string for an unparseable date', () => {
    expect(relativeTimeAgo('not-a-date', NOW)).toBe('');
  });
});
