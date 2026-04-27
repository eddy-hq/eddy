// Promotional-shape patterns we explicitly refuse to surface as a bio.
// Channels routinely lead their description with a CTA ("SUBSCRIBE for daily
// uploads 🔔") — that text is technically the first sentence but it's not
// who they are, so we drop it rather than display it.
const PROMO_PATTERNS: RegExp[] = [
  /\bsubscribe\b/i,
  /🔔/,
  /\bjoin (my|us|our)\b/i,
  /\blike and subscribe\b/i,
  /\bhit the bell\b/i,
  /\bsmash that\b/i,
  /\bfollow me on\b/i,
  /\bpatreon\b/i,
  /\bmerch\b/i,
];

const MIN_BIO_LEN = 8;
const MAX_BIO_LEN = 280;

export function extractBio(description: string | null | undefined): string | null {
  if (!description) return null;
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;

  const sliced = collapsed.slice(0, MAX_BIO_LEN + 1);
  const match = sliced.match(/^[^.?!]+[.?!]?/);
  const sentence = match?.[0]?.trim() ?? '';

  if (sentence.length < MIN_BIO_LEN || sentence.length > MAX_BIO_LEN) return null;
  if (PROMO_PATTERNS.some((re) => re.test(sentence))) return null;

  return sentence;
}
