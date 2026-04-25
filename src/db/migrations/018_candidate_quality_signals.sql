-- Quality signals already fetched from yt-dlp at search time but previously
-- discarded. Storing them lets the scoring prompt see channel and duration,
-- and lets surfaceForToday weight by freshness without re-fetching.

ALTER TABLE candidate_pool ADD COLUMN channel TEXT;
ALTER TABLE candidate_pool ADD COLUMN duration_secs INTEGER;
