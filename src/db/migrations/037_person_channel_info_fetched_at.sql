-- #185 throttling: staleness gate for the per-person channel-info refresh.
-- applyChannelInfoToPerson fires once per followed channel on every RSS poll
-- pass (poller.ts) to refresh bio + avatar. Those are near-static, but the
-- fire-and-forget fan-out turns a daily poll into a wide, concurrent yt-dlp
-- channel-page burst from the shared residential IP. This column records the
-- last successful refresh so the runtime can skip the fetch while it's still
-- fresh (null = never fetched = always stale, so new follows still enrich).

ALTER TABLE people ADD COLUMN channel_info_fetched_at TEXT;

-- Backfill already-enriched rows so the first poll pass after deploy doesn't
-- re-fetch all of them at once. Stagger the stamp across the past 30 days
-- (ISO-8601 UTC, matching new Date().toISOString() at runtime) so they don't
-- all fall stale — and re-fetch — on the same future day. Rows with no bio and
-- no photo stay null: they've never been enriched and will fetch on next poll.
UPDATE people
SET channel_info_fetched_at =
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || abs(random() % 30) || ' days')
WHERE bio IS NOT NULL OR photo_url IS NOT NULL;
