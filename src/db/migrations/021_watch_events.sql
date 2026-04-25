-- Phase 5: append-only stream of video play events.
-- One row per play attempt. A pause-then-resume produces two rows; a rewatch
-- produces another row entirely. Completion percent is derived at read time
-- from position_s / duration_s, so we never need to backfill on schema change.
-- No FK on request_id or user_id: signal must survive request/user deletion.

CREATE TABLE watch_events (
  event_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  video_id     TEXT NOT NULL,             -- youtube_id; denormalised so signal survives request hard-delete
  source       TEXT NOT NULL,             -- feed | discovery | search | channel | history | saved | notification | direct
  started_at   TEXT NOT NULL,             -- ISO 8601
  ended_at     TEXT NOT NULL,
  position_s   INTEGER NOT NULL,          -- final playhead position when stopped
  duration_s   INTEGER NOT NULL,          -- video length, denormalised
  reason       TEXT NOT NULL              -- ended | dismissed | navigated | backgrounded
);

CREATE INDEX idx_watch_events_user_video ON watch_events(user_id, video_id);
CREATE INDEX idx_watch_events_user_started ON watch_events(user_id, started_at);
