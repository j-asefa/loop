ALTER TABLE agents ADD COLUMN effort TEXT;
ALTER TABLE native_sessions ADD COLUMN effort TEXT;
INSERT INTO schema_version VALUES(22, unixepoch()*1000);
