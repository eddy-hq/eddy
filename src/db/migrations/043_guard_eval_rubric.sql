-- Rubric-scored guard verdicts (Phase 6a, candidate-v4).
--
-- Under candidate-v4 the model scores the rubric and code decides the
-- verdict. These columns record which rubric the scores were made under and
-- the scores themselves: per-dimension 0-3, hard stops (none / suspected /
-- clear), flags, and the drivers verdictFromScores reported. Rows from older
-- prompt versions leave both NULL.
ALTER TABLE guard_eval ADD COLUMN rubric_version     TEXT;
ALTER TABLE guard_eval ADD COLUMN rubric_scores_json TEXT;
