-- A bounded live delivery must not be mistaken for a crashed sender by a
-- different API/worker observer. Expiry authorizes recovery, never replay.
ALTER TABLE native_permissions ADD COLUMN delivery_expires_at INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version VALUES(69,unixepoch()*1000);
