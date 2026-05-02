-- Phase 5: extend guard_eval to label the eval stream by request type.
-- Three new nullable columns:
--   request_type  -- 'video' | 'candidate' | 'kid_interest'
--   subject_text  -- raw kid input for 'kid_interest'; null elsewhere
--   interest_id   -- resolved interest id for 'kid_interest'; null elsewhere
-- Backfill: rows with request_id NOT NULL are video evals, else candidate.

ALTER TABLE guard_eval ADD COLUMN request_type TEXT;
ALTER TABLE guard_eval ADD COLUMN subject_text TEXT;
ALTER TABLE guard_eval ADD COLUMN interest_id  TEXT REFERENCES interests(id);

UPDATE guard_eval
   SET request_type = CASE
     WHEN request_id IS NOT NULL THEN 'video'
     ELSE 'candidate'
   END
 WHERE request_type IS NULL;
