-- Richer guard inputs for discovery candidates (Phase 6a, brief §17).
--
-- videos.list already returns description, tags, category and the content
-- rating on every call discovery makes; until now they were discarded. This
-- table keeps them, plus status.madeForKids, so the candidate guard can prompt
-- with more than a bare title.
--
-- Keyed by YouTube id and shared across users: the metadata describes the
-- video, not anyone's relationship with it, so it lives here rather than as
-- per-user columns on candidate_pool. Filled at guard time for candidates that
-- lack a row. Ids the API omits (removed / private) get no row.

CREATE TABLE video_metadata (
  youtube_id      TEXT PRIMARY KEY,
  description     TEXT,               -- NULL when blank
  tags_json       TEXT,               -- JSON array of strings; NULL when none
  category_id     TEXT,               -- snippet.categoryId, e.g. '27'
  age_restricted  INTEGER NOT NULL,   -- 1 when contentRating.ytRating = 'ytAgeRestricted'
  made_for_kids   INTEGER,            -- 0 / 1; NULL when the API did not say
  fetched_at      TEXT NOT NULL       -- ISO 8601
);
