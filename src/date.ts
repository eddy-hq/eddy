// Pure date helpers shared across modules. Flat top-level file with no config,
// DB, queue, or route imports — so any path (the anonymous discovery metadata
// path and the authenticated content download path alike) can reuse it without
// dragging side-effecting init into each other (issue #186).

// Convert yt-dlp's `upload_date` (YYYYMMDD) to an ISO 8601 timestamp at UTC
// midnight, or null when it's absent or not a real calendar date. The
// round-trip check rejects eight-character strings that aren't valid dates
// (e.g. `abcdefgh`, `20261340`, `20260230`), which would otherwise persist a
// bad `published_at` and render an empty pill instead of the requested_at
// fallback.
export function uploadDateToIso(uploadDate: string | null): string | null {
  if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return null;
  const iso = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject out-of-range components (e.g. month 13, day 40) that Date would
  // otherwise silently roll over into the next month/year.
  if (parsed.toISOString() !== iso) return null;
  return iso;
}
