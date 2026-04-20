-- Extend FTS index to include description and transcript.
-- FTS5 virtual tables don't support ALTER TABLE — drop and recreate.

DROP TRIGGER IF EXISTS requests_fts_ai;
DROP TRIGGER IF EXISTS requests_fts_ad;
DROP TRIGGER IF EXISTS requests_fts_au;
DROP TABLE IF EXISTS requests_fts;

CREATE VIRTUAL TABLE requests_fts USING fts5(
  title,
  channel,
  description,
  transcript,
  content='requests',
  content_rowid='rowid',
  tokenize='unicode61'
);

INSERT INTO requests_fts(rowid, title, channel, description, transcript)
SELECT rowid,
       coalesce(title, ''),
       coalesce(channel, ''),
       coalesce(description, ''),
       coalesce(transcript, '')
FROM requests;

CREATE TRIGGER requests_fts_ai AFTER INSERT ON requests BEGIN
  INSERT INTO requests_fts(rowid, title, channel, description, transcript)
  VALUES (new.rowid,
          coalesce(new.title, ''),
          coalesce(new.channel, ''),
          coalesce(new.description, ''),
          coalesce(new.transcript, ''));
END;

CREATE TRIGGER requests_fts_ad AFTER DELETE ON requests BEGIN
  INSERT INTO requests_fts(requests_fts, rowid, title, channel, description, transcript)
  VALUES ('delete', old.rowid,
          coalesce(old.title, ''),
          coalesce(old.channel, ''),
          coalesce(old.description, ''),
          coalesce(old.transcript, ''));
END;

CREATE TRIGGER requests_fts_au AFTER UPDATE ON requests BEGIN
  INSERT INTO requests_fts(requests_fts, rowid, title, channel, description, transcript)
  VALUES ('delete', old.rowid,
          coalesce(old.title, ''),
          coalesce(old.channel, ''),
          coalesce(old.description, ''),
          coalesce(old.transcript, ''));
  INSERT INTO requests_fts(rowid, title, channel, description, transcript)
  VALUES (new.rowid,
          coalesce(new.title, ''),
          coalesce(new.channel, ''),
          coalesce(new.description, ''),
          coalesce(new.transcript, ''));
END;
