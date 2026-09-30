-- Rebuild with foreign keys enabled inside the existing migration transaction.
-- Preserve both inbound tables before replacing their parent; no credential leaves SQLite.
CREATE TEMP TABLE migration035_native_sessions AS SELECT * FROM native_sessions;
CREATE TEMP TABLE migration035_native_dispatches AS SELECT * FROM native_dispatches;
CREATE TEMP TABLE migration035_native_projection AS SELECT * FROM native_projection;
DROP TABLE native_projection;
DROP TABLE native_dispatches;
DROP TABLE native_sessions;
CREATE TABLE native_sessions (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), owner_id TEXT NOT NULL,
 environment_id TEXT NOT NULL REFERENCES execution_environments(host_id), generation INTEGER NOT NULL,
 flavor TEXT NOT NULL CHECK(flavor IN ('codex','claude','opencode','pi')), billing TEXT NOT NULL,
 launch_id TEXT NOT NULL UNIQUE, hub_session_id TEXT, native_thread_id TEXT,
 lineage TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'new',
 history_epoch INTEGER, cursor_seq INTEGER, cursor_at INTEGER, sse_cursor TEXT,
 coherent INTEGER NOT NULL DEFAULT 1, gateway_secret TEXT NOT NULL,
 gateway_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO native_sessions SELECT * FROM migration035_native_sessions;
DROP TABLE migration035_native_sessions;
CREATE TABLE native_dispatches (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), conversation_id TEXT NOT NULL REFERENCES native_sessions(conversation_id),
 local_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, envelope TEXT NOT NULL,
 billing TEXT NOT NULL, environment_id TEXT NOT NULL, generation INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared', auth_evidence TEXT NOT NULL DEFAULT '{}',
 native_turn_id TEXT, send_started_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO native_dispatches SELECT * FROM migration035_native_dispatches;
DROP TABLE migration035_native_dispatches;
CREATE TABLE native_projection (
 conversation_id TEXT NOT NULL REFERENCES native_sessions(conversation_id),
 external_id TEXT NOT NULL, revision TEXT NOT NULL, message_id TEXT,
 payload TEXT NOT NULL, PRIMARY KEY(conversation_id,external_id)
);
INSERT INTO native_projection SELECT * FROM migration035_native_projection;
DROP TABLE migration035_native_projection;
CREATE INDEX native_dispatch_state ON native_dispatches(state);
INSERT INTO schema_version VALUES(35,unixepoch()*1000);
