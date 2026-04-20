-- Phase 4: people, person_outputs, followed_people, seen_videos

CREATE TABLE IF NOT EXISTS people (
  person_id     TEXT PRIMARY KEY,
  display_name  TEXT,
  person_type   TEXT,
  photo_url     TEXT,
  bio           TEXT,
  support_urls  TEXT,
  created_at    TIMESTAMP
);

CREATE TABLE IF NOT EXISTS person_outputs (
  output_id     TEXT PRIMARY KEY,
  person_id     TEXT REFERENCES people(person_id),
  output_type   TEXT,
  fetcher_type  TEXT,
  feed_url      TEXT,
  external_id   TEXT,
  active        INTEGER DEFAULT 1,
  last_polled   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_person_outputs_external
  ON person_outputs(output_type, external_id);

CREATE TABLE IF NOT EXISTS followed_people (
  user_id       TEXT,
  person_id     TEXT REFERENCES people(person_id),
  trust_weight  REAL DEFAULT 1.0,
  followed_at   TIMESTAMP,
  followed_via  TEXT,
  PRIMARY KEY (user_id, person_id)
);

-- Tracks which video IDs have been seen per channel so the RSS poller skips them.
CREATE TABLE IF NOT EXISTS seen_videos (
  channel_id    TEXT NOT NULL,
  video_id      TEXT NOT NULL,
  seen_at       TIMESTAMP NOT NULL,
  PRIMARY KEY (channel_id, video_id)
);
