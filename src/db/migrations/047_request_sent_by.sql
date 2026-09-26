-- Parent picks (#217): a parent sends a video already in their own library to
-- a kid's feed. The kid's row carries `source = 'parent_pick'` (requests.source
-- is a comment, not a CHECK — see 001_initial.sql) and records which parent
-- sent it, for the card's "From <parent>" provenance line. NULL on every other
-- source.

ALTER TABLE requests ADD COLUMN sent_by TEXT REFERENCES users(user_id);
