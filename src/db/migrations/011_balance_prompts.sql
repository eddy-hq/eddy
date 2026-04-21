CREATE TABLE IF NOT EXISTS balance_prompts (
  prompt_id    TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  topic_id     TEXT NOT NULL,
  topic_label  TEXT NOT NULL,
  concentration REAL NOT NULL,
  shown_at     TEXT NOT NULL,
  chosen       INTEGER NOT NULL DEFAULT 0,
  chosen_at    TEXT
);
