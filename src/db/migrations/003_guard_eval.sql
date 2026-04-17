-- Phase 3: extend guard_eval for full eval dataset tracking
ALTER TABLE guard_eval ADD COLUMN gemma_confidence  REAL;
ALTER TABLE guard_eval ADD COLUMN prompt_version    TEXT;
ALTER TABLE guard_eval ADD COLUMN scored_at         TEXT;
ALTER TABLE guard_eval ADD COLUMN human_labelled_at TEXT;
