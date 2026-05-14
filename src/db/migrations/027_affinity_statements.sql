-- Phase 5 follow-up (brief §9a Layer 4): richer inferred_affinities.
--
-- The flat (description, updated_at) shape modelled a single live snapshot
-- per user. The new shape records each Gemma-generated statement with its
-- confidence, when it was produced, and when it was superseded by a newer
-- run — old rows are never deleted so we keep an audit trail of how the
-- profile drifted over time.
--
-- A separate affinity_evidence table pins each statement to the rows that
-- justified it (content_item / person / interest), so a future "why this?"
-- can cite the evidence and a future drift observation can ask the user to
-- confirm or reject a specific statement on the basis of what fed it.

-- Add the new columns. SQLite ADD COLUMN can't take a non-constant DEFAULT,
-- so generated_at is populated via UPDATE below.
ALTER TABLE inferred_affinities ADD COLUMN statement TEXT;
ALTER TABLE inferred_affinities ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE inferred_affinities ADD COLUMN generated_at TEXT;
ALTER TABLE inferred_affinities ADD COLUMN superseded_at TEXT;

-- Backfill from the legacy columns. The 0.5 confidence default already
-- covers existing rows; description copies straight to statement and
-- updated_at to generated_at.
UPDATE inferred_affinities
SET statement = description,
    generated_at = updated_at
WHERE statement IS NULL;

-- Old description/updated_at columns are no longer read by any caller;
-- drop them so the table shape matches the new contract. SQLite 3.35+
-- supports DROP COLUMN directly.
ALTER TABLE inferred_affinities DROP COLUMN description;
ALTER TABLE inferred_affinities DROP COLUMN updated_at;

-- Active-affinity reads filter on superseded_at IS NULL and sort by
-- confidence DESC; the partial index keeps that hot path cheap as the
-- table accumulates historical rows.
CREATE INDEX IF NOT EXISTS idx_affinities_user_active
  ON inferred_affinities(user_id, confidence DESC)
  WHERE superseded_at IS NULL;

-- Evidence rows linking a statement to the underlying signal. ref_type is
-- constrained to the three sources the digest synthesises from; SQLite has
-- no enum type so we use a CHECK constraint.
CREATE TABLE IF NOT EXISTS affinity_evidence (
  evidence_id  TEXT PRIMARY KEY,
  affinity_id  TEXT NOT NULL REFERENCES inferred_affinities(affinity_id),
  ref_type     TEXT NOT NULL CHECK (ref_type IN ('content_item', 'person', 'interest')),
  ref_id       TEXT NOT NULL,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_affinity_evidence_affinity
  ON affinity_evidence(affinity_id);
