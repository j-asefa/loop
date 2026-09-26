-- Local workspace metadata is separate from authoritative native harness history.
CREATE TABLE harnesses(name TEXT PRIMARY KEY, options TEXT NOT NULL, billing TEXT NOT NULL, capabilities TEXT NOT NULL, models TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE project_paths(folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE, path TEXT NOT NULL UNIQUE);
CREATE TABLE native_sessions(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), harness TEXT NOT NULL, native_id TEXT, project TEXT NOT NULL, model TEXT, instructions TEXT NOT NULL DEFAULT '', generation TEXT, state TEXT NOT NULL DEFAULT 'idle', last_run_id TEXT, updated_at INTEGER NOT NULL, UNIQUE(harness,native_id));
CREATE TABLE native_dispatch(run_id TEXT PRIMARY KEY REFERENCES runs(id), generation TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE native_items(conversation_id TEXT NOT NULL REFERENCES conversations(id), native_id TEXT NOT NULL, run_id TEXT REFERENCES runs(id), item TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,native_id));
CREATE TABLE native_decisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), generation TEXT NOT NULL, native_id TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', command_id TEXT, digest TEXT, created_at INTEGER NOT NULL, UNIQUE(conversation_id,generation,native_id));
CREATE TABLE legacy_imports(path TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), digest TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE native_catalog(id TEXT PRIMARY KEY, harness TEXT NOT NULL, native_id TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL, history TEXT, updated_at INTEGER NOT NULL, UNIQUE(harness,native_id));
INSERT INTO schema_version VALUES(19,unixepoch()*1000);
