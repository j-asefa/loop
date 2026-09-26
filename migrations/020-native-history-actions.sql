CREATE TABLE native_history_actions(id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL REFERENCES native_catalog(id), state TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id), created_at INTEGER NOT NULL);
INSERT INTO schema_version VALUES(20,unixepoch()*1000);
