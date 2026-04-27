import { describe, it, expect } from 'vitest';
import { extractBio } from './util';

describe('extractBio', () => {
  it('returns null for null/undefined/empty', () => {
    expect(extractBio(null)).toBeNull();
    expect(extractBio(undefined)).toBeNull();
    expect(extractBio('')).toBeNull();
    expect(extractBio('   \n  \t')).toBeNull();
  });

  it('returns the first sentence of a clean description', () => {
    const desc = 'A family-friendly channel about Lego builds. New videos every week.';
    expect(extractBio(desc)).toBe('A family-friendly channel about Lego builds.');
  });

  it('falls back to the whole text when there is no terminal punctuation', () => {
    expect(extractBio('Bricks and bots, every Friday')).toBe('Bricks and bots, every Friday');
  });

  it('collapses whitespace and newlines into the bio', () => {
    const desc = 'Two\n\n  brothers   building   stuff.\nMore details below.';
    expect(extractBio(desc)).toBe('Two brothers building stuff.');
  });

  it('rejects descriptions whose first sentence demands a subscribe', () => {
    expect(extractBio('SUBSCRIBE for daily uploads. We make Lego videos.')).toBeNull();
    expect(extractBio('Please subscribe to support the show!')).toBeNull();
  });

  it('rejects descriptions cued by the bell emoji', () => {
    expect(extractBio('Hit the bell 🔔 for new uploads.')).toBeNull();
  });

  it('rejects "join my" / "join our" promotional shapes', () => {
    expect(extractBio('Join my Discord for live streams.')).toBeNull();
    expect(extractBio('Join our Patreon community today.')).toBeNull();
  });

  it('rejects other promotional shapes from the denylist', () => {
    expect(extractBio('Like and subscribe to win merch!')).toBeNull();
    expect(extractBio('Smash that like button.')).toBeNull();
    expect(extractBio('Follow me on Instagram for behind-the-scenes.')).toBeNull();
    expect(extractBio('Support us on Patreon for early access.')).toBeNull();
  });

  it('rejects too-short first sentences', () => {
    expect(extractBio('Hi.')).toBeNull();
  });

  it('rejects unreasonably long single-sentence descriptions', () => {
    const oneLong = 'A'.repeat(400);
    expect(extractBio(oneLong)).toBeNull();
  });

  it('preserves punctuation inside the sentence', () => {
    expect(extractBio('Curious? We answer the questions kids ask.')).toBe('Curious?');
  });
});
