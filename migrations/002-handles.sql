CREATE TABLE IF NOT EXISTS handles(name TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), reserved_at INTEGER NOT NULL);
INSERT OR IGNORE INTO handles SELECT normalized_name,id,created_at FROM agents;
INSERT OR IGNORE INTO schema_version VALUES(2,unixepoch()*1000);
