-- Server push, stage 4 of the native iOS shell (brief §21, ADR-0013).
--
-- Two additions, both driven by the same privacy rule (ADR-0004): what transits
-- Apple is an opaque id and placeholder copy, and the real content is fetched
-- back from the M4 over the tailnet.
--
-- 1. `devices` — the table has existed since 001 and has never been written to.
--    It becomes the home for a device's push identity: the APNs token, which of
--    Apple's two environments that token is valid in (a cable build from Xcode
--    gets a sandbox token, an ad hoc build a production one — the same device
--    can hold either over its life), and when the device last registered.
--    The partial unique index enforces what APNs already guarantees: one token
--    belongs to exactly one device, so a restored backup or a handed-down phone
--    moves the row rather than duplicating it.
--
-- 2. `notification_messages` — the content behind an opaque id, read by the
--    Notification Service Extension through GET /notifications/:messageId and
--    only ever by its recipient. Rows are short-lived: the extension fetches
--    within seconds of delivery, and nothing else reads them.

ALTER TABLE devices ADD COLUMN apns_token TEXT;
ALTER TABLE devices ADD COLUMN apns_environment TEXT; -- 'sandbox' | 'production'
ALTER TABLE devices ADD COLUMN last_seen_at TEXT;     -- ISO 8601

CREATE UNIQUE INDEX idx_devices_apns_token
  ON devices (apns_token) WHERE apns_token IS NOT NULL;

CREATE INDEX idx_devices_owner ON devices (owner_user_id);

CREATE TABLE notification_messages (
  message_id  TEXT PRIMARY KEY,                       -- random UUID v7; never a request or YouTube id
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  action_url  TEXT,
  created_at  TEXT NOT NULL                           -- ISO 8601; doubles as the expiry clock
);

CREATE INDEX idx_notification_messages_created_at ON notification_messages (created_at);
