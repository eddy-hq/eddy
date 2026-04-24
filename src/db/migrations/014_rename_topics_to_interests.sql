-- Phase 5: rename "topic" → "interest" throughout the user-interest schema.
-- ntfy "topics" (notification channels) are unrelated and untouched.

ALTER TABLE topics RENAME TO interests;
ALTER TABLE user_topics RENAME TO user_interests;
ALTER TABLE channel_topic_links RENAME TO channel_interest_links;

ALTER TABLE user_interests RENAME COLUMN topic_id TO interest_id;
ALTER TABLE candidate_pool RENAME COLUMN topic_id TO interest_id;
ALTER TABLE channel_interest_links RENAME COLUMN topic_id TO interest_id;
ALTER TABLE balance_prompts RENAME COLUMN topic_id TO interest_id;
ALTER TABLE balance_prompts RENAME COLUMN topic_label TO interest_label;
ALTER TABLE content_items RENAME COLUMN topic TO interest;

UPDATE candidate_pool SET source_type = 'interest_search' WHERE source_type = 'topic_search';
