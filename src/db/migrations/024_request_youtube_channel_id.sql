-- Universal channel tap-through: capture youtube_channel_id on the request at
-- download time so feed/requests responses can carry it to the client. The PWA
-- uses POST /people/resolve with this id to navigate to /person/:personId for
-- any creator, followed or not. Pre-migration rows stay NULL until backfilled
-- (scripts/backfill-channel-id.ts) — a NULL just falls through to the prior
-- followed-only tap behaviour.
ALTER TABLE requests ADD COLUMN youtube_channel_id TEXT;
