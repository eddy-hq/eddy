-- Parent decisions (Phase 6a, slice 1).
--
-- A parent's Allow / Block on an Escalation or a Spot check is a label about a
-- video for a kid, not about one model run: a video carries several guard_eval
-- rows (live verdict, re-run measurements, the second pass), and older
-- candidate rows record neither the kid nor the candidate. Labels therefore
-- live in their own table, and every model is scored against the same labels.
-- guard_eval.human_verdict is still set on the verdict row the parent was
-- shown when that row is unambiguous (eval_id below).
CREATE TABLE IF NOT EXISTS guard_decisions (
  decision_id    TEXT PRIMARY KEY,            -- UUID v7
  subject_type   TEXT NOT NULL,               -- 'candidate' | 'request'
  subject_id     TEXT NOT NULL,               -- candidate_id | request_id
  user_id        TEXT NOT NULL REFERENCES users(user_id), -- the kid
  url            TEXT NOT NULL,
  youtube_id     TEXT,
  age_band       TEXT NOT NULL,               -- the kid's band when decided
  rubric_version TEXT NOT NULL,               -- RUBRIC_VERSION when decided
  source         TEXT NOT NULL,               -- 'escalation' | 'spot_check' | 'catch_up'
  guard_verdict  TEXT,                        -- the guard verdict the subject carried
  eval_id        TEXT,                        -- guard_eval row shown, when unambiguous
  human_verdict  TEXT NOT NULL,               -- 'clear_yes' | 'clear_no'
  decided_by     TEXT NOT NULL REFERENCES users(user_id), -- the parent
  decided_at     TEXT NOT NULL,               -- ISO 8601
  UNIQUE (subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_guard_decisions_user ON guard_decisions(user_id, decided_at);

-- Candidate verdicts from now on record which kid and candidate they judged,
-- so the parent surface can find the exact row. NULL on older rows.
ALTER TABLE guard_eval ADD COLUMN user_id      TEXT;
ALTER TABLE guard_eval ADD COLUMN candidate_id TEXT;

UPDATE guard_eval
   SET user_id = (SELECT r.user_id FROM requests r WHERE r.request_id = guard_eval.request_id)
 WHERE request_id IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_guard_eval_request_id   ON guard_eval(request_id);
CREATE INDEX IF NOT EXISTS idx_guard_eval_candidate_id ON guard_eval(candidate_id);
CREATE INDEX IF NOT EXISTS idx_guard_eval_url          ON guard_eval(url);

-- Spot checks drawn for a UTC day, so the queue is stable across reloads.
-- Catch-up draws land here too, in batches, under the same day.
CREATE TABLE IF NOT EXISTS guard_spot_checks (
  day           TEXT NOT NULL,                -- YYYY-MM-DD (UTC)
  subject_type  TEXT NOT NULL,                -- 'candidate' | 'request'
  subject_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  source        TEXT NOT NULL,                -- 'spot_check' | 'catch_up'
  guard_verdict TEXT NOT NULL,                -- 'clear_yes' | 'clear_no' when drawn
  created_at    TEXT NOT NULL,                -- ISO 8601
  PRIMARY KEY (day, subject_type, subject_id)
);
