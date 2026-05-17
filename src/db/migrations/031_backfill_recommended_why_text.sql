-- Pre-#131 create_candidate INSERTs didn't carry whyText through, so any
-- request created from a discovery candidate before that deploy has NULL
-- why_text on the requests row even though candidate_pool still holds the
-- Gemma rationale. Repair from candidate_pool, matched on the youtube_id
-- carry-through (candidate_pool.external_id == requests.youtube_id) inside
-- the same user. Going forward the descriptor writes why_text on insert,
-- so this is a one-shot historical fix.

UPDATE requests
   SET why_text = (
     SELECT c.why_text
       FROM candidate_pool c
      WHERE c.external_id = requests.youtube_id
        AND c.user_id = requests.user_id
        AND c.why_text IS NOT NULL
      LIMIT 1
   )
 WHERE source = 'recommended'
   AND why_text IS NULL;
