-- Enable WAL mode for better concurrent read performance
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'kid', -- 'parent' | 'kid'
  age_gate      INTEGER NOT NULL DEFAULT 0,  -- boolean
  profile       TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at    TEXT NOT NULL                -- ISO 8601
);

CREATE TABLE devices (
  device_id      TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL REFERENCES users(user_id),
  tailscale_ip   TEXT,
  local_ip       TEXT,
  device_type    TEXT NOT NULL, -- 'phone' | 'tablet' | 'tv' | 'desktop'
  created_at     TEXT NOT NULL
);

CREATE TABLE requests (
  request_id        TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(user_id),
  source            TEXT NOT NULL, -- 'share_sheet' | 'search' | 'channel_subscription' | 'dns_landing'
  url               TEXT NOT NULL,
  youtube_id        TEXT,
  title             TEXT,
  channel           TEXT,
  description       TEXT,
  transcript        TEXT,
  duration_secs     INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'guard_review' | 'parent_review' | 'approved' | 'rejected'
  -- | 'downloading' | 'ready' | 'watched' | 'dismissed'
  guard_verdict     TEXT, -- 'clear_yes' | 'clear_no' | 'uncertain'
  guard_reason      TEXT,
  decided_by        TEXT, -- 'gemma' | user_id
  rejection_reason  TEXT,
  file_path         TEXT,
  nginx_url         TEXT,
  requested_at      TEXT NOT NULL,
  decided_at        TEXT,
  downloaded_at     TEXT,
  watched_at        TEXT
);

CREATE INDEX idx_requests_user_id ON requests(user_id);
CREATE INDEX idx_requests_status  ON requests(status);
CREATE INDEX idx_requests_youtube_id ON requests(youtube_id);

CREATE TABLE content_items (
  item_id       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  content_type  TEXT NOT NULL, -- 'video' | 'article' | 'podcast' | 'paper'
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,
  url           TEXT NOT NULL,
  topic         TEXT,
  score         REAL NOT NULL DEFAULT 0,
  personal_hook TEXT, -- Gemma-generated, <=15 words
  tapped        INTEGER NOT NULL DEFAULT 0,
  saved         INTEGER NOT NULL DEFAULT 0,
  dismissed     INTEGER NOT NULL DEFAULT 0,
  completed     INTEGER NOT NULL DEFAULT 0,
  dwell_secs    INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL,
  tapped_at     TEXT
);

CREATE INDEX idx_content_items_user_id ON content_items(user_id);
CREATE INDEX idx_content_items_dismissed ON content_items(dismissed);

CREATE TABLE topics (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  emoji        TEXT,
  search_terms TEXT NOT NULL DEFAULT '[]', -- JSON array
  category     TEXT,
  age_gate     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'seed' -- 'seed' | 'user_added'
);

CREATE TABLE user_topics (
  user_id   TEXT NOT NULL REFERENCES users(user_id),
  topic_id  TEXT NOT NULL REFERENCES topics(id),
  weight    REAL NOT NULL DEFAULT 1.0,
  liked     INTEGER NOT NULL DEFAULT 1,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);

CREATE TABLE overrides (
  override_id    TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  device_id      TEXT REFERENCES devices(device_id),
  granted_by     TEXT NOT NULL REFERENCES users(user_id),
  duration_mins  INTEGER NOT NULL,
  expires_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'revoked'
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_overrides_user_status ON overrides(user_id, status);

CREATE TABLE drift (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  week           TEXT NOT NULL, -- ISO: "2026-W15"
  summary        TEXT NOT NULL DEFAULT '{}', -- JSON: signals, observations, one-sentence
  calculated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, week)
);

CREATE TABLE guard_eval (
  eval_id        TEXT PRIMARY KEY,
  request_id     TEXT REFERENCES requests(request_id),
  url            TEXT NOT NULL,
  gemma_verdict  TEXT,
  gemma_reason   TEXT,
  human_verdict  TEXT, -- labelled by Steve for eval set
  human_notes    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE used_tokens (
  token_hash  TEXT PRIMARY KEY,
  handler     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  used_at     TEXT NOT NULL
);

CREATE TABLE seen_videos (
  channel_id  TEXT NOT NULL,
  video_id    TEXT NOT NULL,
  seen_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, video_id)
);
