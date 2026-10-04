-- Some early Pi workspaces recorded migration 37 before this table existed.
-- Keep those databases compatible with the inbox and reading-position APIs.
CREATE TABLE IF NOT EXISTS conversation_positions(owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, position_message_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id, conversation_id));
INSERT INTO schema_version VALUES(49,unixepoch()*1000);
