-- Durable dismissals for follow suggestions (#151). A follow suggestion is a
-- live, cheap-SQL surface: engaged-but-not-followed channels that map to a
-- declared interest, shown on the People tab. A Dismiss is a human act that
-- says "stop suggesting this creator" — it does NOT unfollow (the user never
-- followed) and it does NOT touch engagement signal. We record only the
-- dismissals (one row per user+channel), so re-deriving the live suggestion
-- set can subtract them and never resurface a dismissed channel.
CREATE TABLE IF NOT EXISTS follow_suggestion_dismissals (
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  channel_id   TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
