-- Phase 5: rank-replaces-weight on user_interests. Adds a per-user-per-interest
-- expertise level. Existing weight values seed the initial rank order
-- (ties broken by added_at ascending).

ALTER TABLE user_interests ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_interests ADD COLUMN expertise TEXT NOT NULL DEFAULT 'comfortable'
  CHECK (expertise IN ('beginner','comfortable','deep'));

UPDATE user_interests AS ui
SET rank = ranked.rn
FROM (
  SELECT rowid AS rid,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY weight DESC, added_at ASC) AS rn
  FROM user_interests
) AS ranked
WHERE ranked.rid = ui.rowid;

ALTER TABLE user_interests DROP COLUMN weight;
