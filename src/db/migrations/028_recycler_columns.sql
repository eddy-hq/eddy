-- Issue #114 / #113: per-user storage recycling — accounting columns only.
-- file_size_bytes: bytes on disk when the file was downloaded. Null for rows
--   without a live file (creation, downloading, rejected, gone, …). Populated
--   by mark_downloaded on new downloads and a one-off backfill for live rows
--   that pre-date this migration.
-- recycled_at:     ISO 8601 timestamp the file was recycled. Null until the
--   row's file is recycled. Recycler logic lands in a follow-up sub-issue;
--   this migration only reserves the column so the schema is in place first.

ALTER TABLE requests ADD COLUMN file_size_bytes INTEGER;
ALTER TABLE requests ADD COLUMN recycled_at     TEXT;
