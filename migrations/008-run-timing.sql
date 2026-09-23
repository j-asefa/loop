ALTER TABLE runs ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN active_since INTEGER;
-- Start measuring existing active runs at their last known heartbeat. Historical
-- queue/pause durations cannot be reconstructed and must not be billed as work.
UPDATE runs SET active_since=heartbeat WHERE state IN ('running','pausing') AND worker_id IS NOT NULL;
INSERT INTO schema_version VALUES(8,unixepoch()*1000);
