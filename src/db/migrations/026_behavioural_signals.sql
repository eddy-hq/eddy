-- Phase 5 follow-up (brief §9a Layer 2): per-(user, person) engagement snapshot
-- recomputed nightly by the profile-enrichment job. Drives Layer 3 trust
-- weights via watched_count / (watched_count + dismissed_count).
--
-- One row per (user_id, person_id). Recomputed in place, not append-only —
-- the table is a snapshot, not a stream.

CREATE TABLE IF NOT EXISTS behavioural_signals (
  user_id          TEXT NOT NULL,
  person_id        TEXT NOT NULL REFERENCES people(person_id),
  watched_count    INTEGER NOT NULL DEFAULT 0,
  dismissed_count  INTEGER NOT NULL DEFAULT 0,
  recomputed_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_behavioural_signals_user
  ON behavioural_signals(user_id);
