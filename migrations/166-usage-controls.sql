ALTER TABLE mcp_preferences ADD COLUMN auto_watch_prs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_preferences ADD COLUMN max_concurrent_per_harness INTEGER;
