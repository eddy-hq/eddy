-- Phase 4: FTS5 full-text search over requests (title + channel)
-- Content table — index only, rowid maps back to requests.rowid
CREATE VIRTUAL TABLE requests_fts USING fts5(
  title,
  channel,
  content='requests',
  content_rowid='rowid',
  tokenize='unicode61'
);

INSERT INTO requests_fts(rowid, title, channel)
SELECT rowid, coalesce(title, ''), coalesce(channel, '') FROM requests;

CREATE TRIGGER requests_fts_ai AFTER INSERT ON requests BEGIN
  INSERT INTO requests_fts(rowid, title, channel)
  VALUES (new.rowid, coalesce(new.title, ''), coalesce(new.channel, ''));
END;

CREATE TRIGGER requests_fts_ad AFTER DELETE ON requests BEGIN
  INSERT INTO requests_fts(requests_fts, rowid, title, channel)
  VALUES ('delete', old.rowid, coalesce(old.title, ''), coalesce(old.channel, ''));
END;

CREATE TRIGGER requests_fts_au AFTER UPDATE ON requests BEGIN
  INSERT INTO requests_fts(requests_fts, rowid, title, channel)
  VALUES ('delete', old.rowid, coalesce(old.title, ''), coalesce(old.channel, ''));
  INSERT INTO requests_fts(rowid, title, channel)
  VALUES (new.rowid, coalesce(new.title, ''), coalesce(new.channel, ''));
END;
