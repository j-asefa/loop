-- The workspace's standing approval level for native harness tool calls
-- (shell commands, file edits). NULL keeps the harness default: ask every time.
ALTER TABLE mcp_preferences ADD COLUMN agent_permission_mode TEXT;
INSERT INTO schema_version VALUES(52,unixepoch()*1000);
