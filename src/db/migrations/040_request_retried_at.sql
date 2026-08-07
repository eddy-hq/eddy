-- Manual-download continuity (tap-to-download follow-up). The feed hides
-- follow-sourced rows while status is pending/downloading so fresh channel
-- uploads arrive only when ready (ADR-0009) — but that same exclusion made a
-- FAILED follow row vanish from the feed the moment a kid tapped its manual
-- download (failed → downloading). Stamp retries so the feed can tell a
-- retried download (was visible as failed, must stay visible with its
-- progress UI) from a first-time auto-download (never shown, stays hidden
-- until ready). Nullable; never cleared — "has ever been manually retried"
-- is exactly the visibility signal wanted, and mark_downloaded's flip to
-- 'ready' ends the exclusion's relevance anyway.

ALTER TABLE requests ADD COLUMN retried_at TEXT;
