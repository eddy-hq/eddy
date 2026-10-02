-- Block kinds (#227): a parent's Block means either "unsafe" for this kid or
-- "not for us" (quality, taste, relevance, a sales channel). The guard is
-- measured on safety only, so the kind is recorded beside the Block.
--
-- human_verdict stays 'clear_no' for both kinds, so everything that reads it
-- (the live Block effect, currentParentBlock, the second pass and download
-- callback checks) is unchanged. NULL on a Block is "kind not recorded" (every
-- row before this migration, and an older client); always NULL on an Allow.
ALTER TABLE guard_decisions
  ADD COLUMN block_kind TEXT CHECK (block_kind IN ('unsafe', 'not_for_us'));
ALTER TABLE guard_decision_revisions
  ADD COLUMN block_kind TEXT CHECK (block_kind IN ('unsafe', 'not_for_us'));

-- A revision that only sets the kind on a Block that was already a Block. It is
-- a label for Review and the harness, never a new answer: currentParentBlock
-- leaves it out so a fresh timestamp can't outrank a later Allow.
ALTER TABLE guard_decision_revisions
  ADD COLUMN kind_only INTEGER NOT NULL DEFAULT 0 CHECK (kind_only IN (0, 1));
