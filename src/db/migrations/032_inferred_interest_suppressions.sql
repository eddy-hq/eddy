-- Sparse suppression store for Removed inferred-interest proposals (#156).
-- Inferred interests are derived live (follows → channel_interest_links →
-- interests); they are never written to the profile until Kept. A Remove is a
-- human act that says "don't propose this again" — it does NOT unfollow. We
-- record only the suppressions (one row per user+interest), so re-deriving the
-- live set can subtract them and never resurface a Removed proposal.
CREATE TABLE IF NOT EXISTS inferred_interest_suppressions (
  user_id      TEXT NOT NULL,
  interest_id  TEXT NOT NULL REFERENCES interests(id),
  suppressed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, interest_id)
);
