-- Brief §9a: scoring is meant to combine connection × quality × freshness, not
-- a single fuzzy number. Splitting connection and quality lets the surface
-- step apply a hard floor on each axis ("no padding the feed with barely
-- tolerable picks") and gives the rescore/preview loop two readable signals
-- when iterating on the prompt. gemma_score is retained as the product / 10
-- so older code paths (e.g. guardCandidates' top-N) keep working.

ALTER TABLE candidate_pool ADD COLUMN connection_score REAL;
ALTER TABLE candidate_pool ADD COLUMN quality_score REAL;
