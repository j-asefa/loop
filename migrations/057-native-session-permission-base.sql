-- The workspace permission level in effect when a session's own mode was
-- chosen. A later change to that level supersedes the session's choice.
ALTER TABLE companion_sessions ADD COLUMN permission_base TEXT;
INSERT INTO schema_version VALUES(57,unixepoch()*1000);
