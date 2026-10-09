-- Device credentials (ADR-0016).
--
-- The acting user used to be whatever `userId` the client sent. A device row
-- now also carries the credential that device presents on every API call, and
-- the server reads the acting user from the row's `owner_user_id`.
--
-- Only the SHA-256 of the credential is stored: the secret itself lives in the
-- device's cookie jar (browser) or Keychain (iOS shell), and a copy of this
-- database is not a set of keys to the house.
--
-- Existing rows are push-only registrations from before enrolment existed.
-- They keep `credential_hash` NULL, keep receiving pushes until the device
-- re-enrols and claims its token on a credentialed row, and never authenticate.

ALTER TABLE devices ADD COLUMN credential_hash TEXT;

CREATE UNIQUE INDEX idx_devices_credential_hash
  ON devices (credential_hash) WHERE credential_hash IS NOT NULL;
