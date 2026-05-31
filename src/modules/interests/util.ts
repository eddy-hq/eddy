// Slugify a free-text interest label into a stable interest id: lowercase,
// non-alphanumeric runs collapsed to underscores, trimmed of leading/trailing
// underscores. May return an empty string for an all-punctuation label — the
// caller decides the fallback (a uuid for user-added, skip for inference).
export function slugifyInterestLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
}
