ALTER TABLE companion_sessions ADD COLUMN worktree_source TEXT;
ALTER TABLE companion_sessions ADD COLUMN worktree_agent_id TEXT;
INSERT INTO schema_version VALUES(72,unixepoch()*1000);
