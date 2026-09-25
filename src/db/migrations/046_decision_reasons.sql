-- Parent decisions, slice 2 (Phase 6a).
--
-- Reason chips: a decision may carry the rubric dimensions the parent tapped
-- and a short free-text note. Both optional; NULL when none was given.
ALTER TABLE guard_decisions ADD COLUMN reason_dimensions_json TEXT; -- JSON array of rubric dimension keys
ALTER TABLE guard_decisions ADD COLUMN reason_text            TEXT; -- parent's note, capped at 280 chars

-- Daily nudge: one "decisions waiting" notification per parent per day. The
-- row is claimed before notify() is called, so a repeat firing on the same day
-- (a restart, a changed schedule) sends nothing.
CREATE TABLE IF NOT EXISTS decision_nudges (
  day      TEXT NOT NULL,                           -- YYYY-MM-DD in the nudge's time zone
  user_id  TEXT NOT NULL REFERENCES users(user_id), -- the parent nudged
  count    INTEGER NOT NULL,                        -- cards waiting when sent
  sent_at  TEXT NOT NULL,                           -- ISO 8601
  PRIMARY KEY (day, user_id)
);
