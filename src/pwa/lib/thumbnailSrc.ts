// The one rule for which image a video tile shows: the server's thumbnail URL
// when it sent one, otherwise nothing — the caller renders its neutral
// placeholder background. There is deliberately no fallback to
// i.ytimg.com/vi/<id>/hqdefault.jpg: that is the creator's own thumbnail,
// which no guard has seen, and a null thumbnail_url is exactly the case where
// Eddy has no vetted image to offer. Same path for every user, kid or adult.
export function thumbnailSrc(thumbnailUrl: string | null | undefined): string | null {
  if (typeof thumbnailUrl !== 'string') return null;
  const trimmed = thumbnailUrl.trim();
  return trimmed ? trimmed : null;
}
