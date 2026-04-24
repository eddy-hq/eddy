-- Phase 5: deprecate the seed-interest taxonomy. With freeform interests,
-- there is no taxonomy to age-gate against; remove the flag.

ALTER TABLE interests DROP COLUMN age_gate;
