-- Candidate-accept INSERTs historically omitted added_at (NULL). The feed
-- query orders by `added_at DESC LIMIT 200`, so those rows sank below every
-- dated request and were silently truncated, making a tap-to-add on a
-- discovery card look identical to a dismiss in the PWA. Backfill from
-- requested_at so the dropped rows surface in the correct day group; the
-- state-machine INSERT now sets added_at going forward.

UPDATE requests
   SET added_at = requested_at
 WHERE source = 'recommended'
   AND added_at IS NULL;
