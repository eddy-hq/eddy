-- Phase 2: thumbnail_url for generated stylised thumbnails
-- Populated at download completion by the Ubuntu worker.
-- Kept when a video file is recycled — thumbnail stays useful for the restore affordance.
ALTER TABLE requests ADD COLUMN thumbnail_url TEXT;
