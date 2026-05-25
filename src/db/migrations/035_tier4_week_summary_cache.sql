-- Issue #143: Gemma-generated editorial line for each Tier 4 week-row.
--
-- The /feed payload's `tier4Weeks[].summary` is populated from this cache, not
-- generated on the request path — the feed handler must never block on Ollama.
-- A row holds the last generated summary for a (user, week-start) pair plus the
-- item_count it was generated against. Feed read serves `summary` only when the
-- stored item_count still matches the week's current count; a mismatch (or a
-- missing row) reads as null and the week is "stale" until the admin
-- regeneration trigger re-runs Gemma for it.
--
-- summary is nullable: a guard rejection or an unreachable Gemma stores null so
-- the front-end renders its templated "{count} items" fallback. prompt_version
-- tracks the generator prompt so a prompt change can invalidate cached lines
-- later if needed. week_start is the ISO date (Monday) of the ISO week, matching
-- isoWeekRange().rangeStart in feed-tiers.ts.

CREATE TABLE IF NOT EXISTS tier4_week_summaries (
  user_id        TEXT NOT NULL,
  week_start     TEXT NOT NULL,
  item_count     INTEGER NOT NULL,
  summary        TEXT,
  prompt_version TEXT NOT NULL,
  generated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, week_start)
);
