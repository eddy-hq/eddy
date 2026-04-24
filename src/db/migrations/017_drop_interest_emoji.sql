-- Interests no longer display an icon in the profile UI, and the
-- freeform user-add flow has replaced the pre-seeded taxonomy. Delete
-- any seed interest that isn't referenced by real user/channel/candidate
-- data, then drop the emoji column entirely.

DELETE FROM interests
WHERE source = 'seed'
  AND id NOT IN (SELECT interest_id FROM user_interests)
  AND id NOT IN (SELECT interest_id FROM channel_interest_links)
  AND id NOT IN (SELECT interest_id FROM candidate_pool WHERE interest_id IS NOT NULL)
  AND id NOT IN (SELECT interest_id FROM balance_prompts);

ALTER TABLE interests DROP COLUMN emoji;
