-- Brief §9a moved the "why this?" affordance from a tap-to-open sheet on the
-- candidate card to inline text on the video detail page. The Gemma rationale
-- was previously stored only on candidate_pool and discarded when a candidate
-- was promoted into a request. Persist it so the detail page can render it for
-- picked items long after the candidate row was dismissed/cleaned up.

ALTER TABLE requests ADD COLUMN why_text TEXT;
