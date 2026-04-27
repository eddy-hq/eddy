-- Enforce uniqueness on person_outputs(output_type, external_id). The original
-- migration (007) only added a non-unique index, which left the door open for
-- duplicate person rows for the same channel if the find-or-create path ever
-- raced. Within a single better-sqlite3 process writes are serialised, so
-- duplicates shouldn't exist today — but the constraint locks that in and
-- makes ensurePersonForChannel's find-or-create semantics safe at the DB level.

-- Dedupe defensively: if any duplicates slipped through historically, keep the
-- lexicographically-smallest output_id for each (output_type, external_id) and
-- drop the rest. followed_people rows reference person_id (not output_id), so
-- this only collapses duplicate output rows pointing at the same channel.
DELETE FROM person_outputs
 WHERE output_id NOT IN (
   SELECT MIN(output_id)
     FROM person_outputs
    WHERE output_type IS NOT NULL AND external_id IS NOT NULL
    GROUP BY output_type, external_id
 )
 AND output_type IS NOT NULL
 AND external_id IS NOT NULL;

DROP INDEX IF EXISTS idx_person_outputs_external;

CREATE UNIQUE INDEX idx_person_outputs_external_unique
  ON person_outputs(output_type, external_id);
