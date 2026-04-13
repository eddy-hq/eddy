-- Phase 2: timeline feed columns
-- saved_at:   when the user bookmarked the card (null = not saved)
-- file_state: live | recycled | gone. Defaults to live for all existing records.
-- added_at:   the date this card entered the user's feed. For requests equals requested_at.
--             Separate column so future sources (RSS, recommendations) set it independently.
-- (watched_at already exists from initial schema)

ALTER TABLE requests ADD COLUMN saved_at    TEXT;
ALTER TABLE requests ADD COLUMN file_state  TEXT NOT NULL DEFAULT 'live';
ALTER TABLE requests ADD COLUMN added_at    TEXT;

-- Back-fill added_at from requested_at for all existing rows
UPDATE requests SET added_at = requested_at;
