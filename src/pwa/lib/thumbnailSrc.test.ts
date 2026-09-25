import { describe, expect, it } from 'vitest';
import { thumbnailSrc } from './thumbnailSrc';

describe('thumbnailSrc', () => {
  it('uses the server thumbnail URL when present', () => {
    expect(thumbnailSrc('https://eddyhq.app/thumbs/abc.jpg')).toBe('https://eddyhq.app/thumbs/abc.jpg');
  });

  it('returns null (neutral placeholder) when the URL is null or undefined', () => {
    expect(thumbnailSrc(null)).toBeNull();
    expect(thumbnailSrc(undefined)).toBeNull();
  });

  it('treats an empty or whitespace-only URL as absent', () => {
    expect(thumbnailSrc('')).toBeNull();
    expect(thumbnailSrc('   ')).toBeNull();
  });

  it('never synthesises a YouTube thumbnail URL', () => {
    for (const input of [null, undefined, '']) {
      expect(thumbnailSrc(input) ?? '').not.toContain('ytimg');
    }
  });
});
