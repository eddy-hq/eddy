-- Accounting columns for per-user storage recycling (#113 / #114).
--
-- file_size_bytes: bytes on disk when the file was downloaded. Captured by
--   the worker after yt-dlp completes and written via the mark_downloaded
--   event. Null for rows that never had a live file (rejected, failed,
--   guard-blocked, in-flight) or for legacy rows until the one-off backfill
--   script (src/scripts/backfill-file-size.ts) runs.
--
-- recycled_at: ISO 8601 timestamp the file was recycled (live → recycled).
--   Null until the recycler runs against this row. Set by the recycler pass
--   landing in a later sub-issue of #113; this migration only adds the
--   column so backfill and capture can ship first.
--
-- This migration is intentionally only the column adds — no recycler logic,
-- no backfill, no UI. Those are sub-issues #115/#116/#117.

ALTER TABLE requests ADD COLUMN file_size_bytes INTEGER;
ALTER TABLE requests ADD COLUMN recycled_at     TEXT;
