-- Blocked channels: a household-wide parent rule. A YouTube channel a parent
-- blocks never reaches any kid's slate, and a kid's request from it is
-- rejected before the guard runs. Adults are unaffected. No channels are
-- seeded here; a parent blocks them with `npm run block-channel` or from a
-- Decisions card.
CREATE TABLE IF NOT EXISTS blocked_channels (
  channel_id   TEXT PRIMARY KEY,                        -- YouTube channel id (UC...)
  display_name TEXT NOT NULL,                           -- channel title when blocked
  reason       TEXT,                                    -- parent's note, optional
  blocked_by   TEXT NOT NULL REFERENCES users(user_id), -- the parent
  blocked_at   TEXT NOT NULL                            -- ISO 8601
);

-- Candidates now carry the channel id they came from, so a block can match on
-- identity rather than on the display name. Filled at intake from here on.
ALTER TABLE candidate_pool ADD COLUMN channel_id TEXT;

-- Backfill, where derivable. Follow-sourced rows take their person's YouTube
-- output, but only when the person has exactly one (a multi-channel person
-- would be a guess).
UPDATE candidate_pool
   SET channel_id = (
         SELECT po.external_id FROM person_outputs po
          WHERE po.person_id = candidate_pool.person_id AND po.output_type = 'youtube'
       )
 WHERE channel_id IS NULL
   AND person_id IS NOT NULL
   AND source_type IN ('subscription', 'person_backcatalog')
   AND (SELECT COUNT(*) FROM person_outputs po
         WHERE po.person_id = candidate_pool.person_id AND po.output_type = 'youtube') = 1;

-- Any other row whose video has been downloaded (for any user) takes the
-- channel id the download recorded. Rows left NULL are matched on display
-- name as a fallback (see modules/blocked-channels).
UPDATE candidate_pool
   SET channel_id = (
         SELECT r.youtube_channel_id FROM requests r
          WHERE r.youtube_id = candidate_pool.external_id
            AND r.youtube_channel_id IS NOT NULL
          ORDER BY r.requested_at DESC LIMIT 1
       )
 WHERE channel_id IS NULL AND external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_pool_channel_id ON candidate_pool(channel_id);
