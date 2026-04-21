-- Phase 5+: soft-delete support for video requests
-- status 'deleted' = user deleted the item; file is gone, record kept for discovery signal
ALTER TABLE requests ADD COLUMN deleted_at TEXT;
