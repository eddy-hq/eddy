-- Decision revisions (#223): a parent re-checks a past decision in Review and
-- changes it. A change is a revision, never an overwrite: the first-pass label
-- in guard_decisions stays as recorded. Several revisions per decision are
-- allowed; the latest (revised_at, then insertion order) is the current answer.
CREATE TABLE IF NOT EXISTS guard_decision_revisions (
  revision_id            TEXT PRIMARY KEY,                              -- UUID v7
  decision_id            TEXT NOT NULL REFERENCES guard_decisions(decision_id),
  human_verdict          TEXT NOT NULL,                                 -- 'clear_yes' | 'clear_no'
  rubric_version         TEXT NOT NULL,                                 -- RUBRIC_VERSION when revised
  reason_dimensions_json TEXT,                                          -- JSON array of rubric dimension keys
  reason_text            TEXT,                                          -- parent's note, capped at 280 chars
  effect                 TEXT NOT NULL,                                 -- 'removed' | 'blocked' | 'eligible' | 'label_only'
  revised_by             TEXT NOT NULL REFERENCES users(user_id),       -- the parent
  revised_at             TEXT NOT NULL                                  -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_guard_decision_revisions_decision
  ON guard_decision_revisions(decision_id, revised_at);
