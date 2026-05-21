-- Inferred interests are derived live from follows (ADR-0008), never stored.
-- A Remove on an inferred-interest proposal must persist so re-deriving does
-- not resurface it — but it does NOT unfollow the person. This sparse table
-- records only the suppressed (user_id, interest_id) pairs; absence means
-- "not suppressed". Keep (promotion to a declared user_interests row) lives
-- in the user_interests table, not here.
CREATE TABLE IF NOT EXISTS inferred_interest_suppressions (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  interest_id   TEXT NOT NULL REFERENCES interests(id),
  suppressed_at TEXT NOT NULL, -- ISO 8601
  PRIMARY KEY (user_id, interest_id)
);
