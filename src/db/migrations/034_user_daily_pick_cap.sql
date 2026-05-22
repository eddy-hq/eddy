-- ADR-0009: per-user daily slate size. The slate is composed into reserved
-- slots up to this ceiling (subscription = cap − 6, back-catalogue 4,
-- delighter 2). Numbers are role-blind — the only kid/adult difference is the
-- guard recheck — so the cap lives on the user, not on role.
--
-- Nullable column: a null reads as "use the global DEFAULT_DAILY_PICK_CAP"
-- (env, default 15) at compose time. Existing rows are backfilled to 15, the
-- established slate size, so behaviour is unchanged on upgrade. A migration
-- can't read the env default, so the literal here must track that default.

ALTER TABLE users ADD COLUMN daily_pick_cap INTEGER;

UPDATE users SET daily_pick_cap = 15 WHERE daily_pick_cap IS NULL;
