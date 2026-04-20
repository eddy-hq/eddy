-- Phase 5: discovery tables

-- Link surfaced content items back to the person who sourced them
ALTER TABLE content_items ADD COLUMN person_id TEXT REFERENCES people(person_id);

-- Candidates gathered by the discovery engine, before and after scoring
CREATE TABLE IF NOT EXISTS candidate_pool (
  candidate_id   TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  content_type   TEXT NOT NULL DEFAULT 'video',
  source_type    TEXT NOT NULL,
  -- 'person_output' | 'person_recommendation' | 'topic_search'
  person_id      TEXT REFERENCES people(person_id),
  topic_id       TEXT REFERENCES topics(id),
  url            TEXT NOT NULL,
  external_id    TEXT,
  title          TEXT,
  thumbnail_url  TEXT,
  published_at   TEXT,
  gemma_score    REAL,
  why_text       TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'scored' | 'surfaced' | 'dismissed' | 'guard_pending' | 'guard_rejected'
  guard_verdict  TEXT,
  surfaced_date  TEXT,
  created_at     TEXT NOT NULL,
  scored_at      TEXT,
  surfaced_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidate_pool_user_status
  ON candidate_pool(user_id, status);
CREATE INDEX IF NOT EXISTS idx_candidate_pool_user_date
  ON candidate_pool(user_id, surfaced_date);
CREATE INDEX IF NOT EXISTS idx_candidate_pool_external
  ON candidate_pool(user_id, external_id);

-- Recommendations Gemma extracts from followed people's text outputs
CREATE TABLE IF NOT EXISTS person_recommendations (
  rec_id             TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL REFERENCES people(person_id),
  source_url         TEXT,
  recommended_url    TEXT NOT NULL,
  recommended_title  TEXT,
  content_type       TEXT,
  gemma_confidence   REAL,
  added_to_pool      INTEGER NOT NULL DEFAULT 0,
  extracted_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_person_recs_person
  ON person_recommendations(person_id);
CREATE INDEX IF NOT EXISTS idx_person_recs_unprocessed
  ON person_recommendations(added_to_pool, extracted_at);

-- Layer 4 of the user profile: Gemma-generated preference descriptions
CREATE TABLE IF NOT EXISTS inferred_affinities (
  affinity_id  TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  description  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_affinities_user
  ON inferred_affinities(user_id);

-- Channel → topic mappings inferred by Gemma at subscribe time
CREATE TABLE IF NOT EXISTS channel_topic_links (
  channel_id   TEXT NOT NULL,
  topic_id     TEXT NOT NULL REFERENCES topics(id),
  confidence   REAL NOT NULL DEFAULT 1.0,
  inferred_at  TEXT NOT NULL,
  PRIMARY KEY (channel_id, topic_id)
);
