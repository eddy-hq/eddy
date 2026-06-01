-- Today cards previously showed `requested_at` (when the video was added to
-- Eddy) — always ~today, so it told you nothing. Store the video's own publish
-- date so a glance distinguishes a fresh upload from a back-catalogue pull.
--
-- The column is captured universally at download time from yt-dlp's
-- `upload_date` (see fetchMetadata → mark_downloaded), so all sources
-- (share-sheet, channel-poll, discovery) are covered going forward. It stays
-- nullable: pre-migration rows and any video yt-dlp can't date show the
-- `requested_at` fallback in the UI.

ALTER TABLE requests ADD COLUMN published_at TEXT;

-- Backfill discovery history cheaply from the candidate row we already scored.
-- candidate_pool.published_at (008_discovery_tables.sql) is the YYYYMMDD upload
-- date converted to ISO at candidate time. The YouTube ID is stored as
-- candidate_pool.external_id, joined to requests.youtube_id (the same join
-- discovery's preview/surface paths use). Non-discovery history stays null and
-- shows the fallback until those rows are naturally re-downloaded.
UPDATE requests
   SET published_at = (
         SELECT cp.published_at
           FROM candidate_pool cp
          WHERE cp.external_id = requests.youtube_id
            AND cp.published_at IS NOT NULL
          LIMIT 1
       )
 WHERE published_at IS NULL
   AND youtube_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM candidate_pool cp
          WHERE cp.external_id = requests.youtube_id
            AND cp.published_at IS NOT NULL
       );
