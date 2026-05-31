-- Issue #181 / ADR-0008 Tier-2 inference. The pre-seeded interest catalogue is
-- no longer a forced inference target — channel inference now free-labels and
-- canonicalises, growing the vocabulary bottom-up. Remove the seed topics that
-- exist ONLY as inference targets (declared by nobody) and were the source of
-- mislabelled, leaking channel links: news_analysis, programming, camping.
--
-- Declared seeds (economics, philosophy, politics, football, …) are real user
-- interests and are left untouched — the final DELETE is guarded so a row that
-- any user has declared is never removed, even if this list grows.

DELETE FROM channel_interest_links
 WHERE interest_id IN ('news_analysis', 'programming', 'camping');

DELETE FROM inferred_interest_suppressions
 WHERE interest_id IN ('news_analysis', 'programming', 'camping');

-- Defensive: candidate tagging is already scoped to declared interests
-- (commit dee0a06), so no live candidate should carry these — null any that do
-- rather than leave a dangling interest_id once the interest row is gone.
UPDATE candidate_pool
   SET interest_id = NULL
 WHERE interest_id IN ('news_analysis', 'programming', 'camping');

DELETE FROM interests
 WHERE id IN ('news_analysis', 'programming', 'camping')
   AND source = 'seed'
   AND id NOT IN (SELECT interest_id FROM user_interests);
