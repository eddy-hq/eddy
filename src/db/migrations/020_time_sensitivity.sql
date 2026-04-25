-- Per-video time-sensitivity classification so the freshness curve can be
-- picked per content type. A football highlight is 'news' (decays in days);
-- a running technique explainer is 'evergreen' (barely decays); most
-- tutorials are 'standard'. Gemma sets this at scoring time.

ALTER TABLE candidate_pool ADD COLUMN time_sensitivity TEXT;
