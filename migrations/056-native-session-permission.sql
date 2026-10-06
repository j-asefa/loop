-- A confirmed Claude session choice survives idle process eviction/resume.
ALTER TABLE companion_sessions ADD COLUMN permission_mode TEXT;
INSERT INTO schema_version VALUES(56,unixepoch()*1000);
