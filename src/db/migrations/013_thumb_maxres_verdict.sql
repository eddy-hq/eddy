-- Cache the classify verdict for the channel-set thumbnail so the thumbnail pipeline
-- doesn't re-call Gemma on every attempt (and on backfills).
ALTER TABLE requests ADD COLUMN thumbnail_maxres_verdict TEXT; -- 'editorial' | 'slop' | NULL
