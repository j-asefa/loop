ALTER TABLE conversations ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE conversations ADD COLUMN execution_connection_id TEXT;
ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES folders(id);
CREATE TABLE execution_environments (
 host_id TEXT PRIMARY KEY REFERENCES runtime_hosts(id), owner_id TEXT NOT NULL,
 instance_id TEXT NOT NULL, namespace TEXT NOT NULL UNIQUE, machine_id TEXT,
 generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'provisioning',
 capacity INTEGER NOT NULL DEFAULT 2 CHECK(capacity BETWEEN 1 AND 32),
 credential_hash TEXT NOT NULL, certificate_fingerprint TEXT NOT NULL,
 health TEXT NOT NULL DEFAULT '{}', last_seen INTEGER, revoked_at INTEGER, event_cursor TEXT
);
CREATE TABLE environment_projects (
 environment_id TEXT NOT NULL REFERENCES execution_environments(host_id),
 project_id TEXT NOT NULL REFERENCES folders(id), canonical_path TEXT NOT NULL,
 repository TEXT, PRIMARY KEY(environment_id,project_id)
);
CREATE TABLE native_sessions (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), owner_id TEXT NOT NULL,
 environment_id TEXT NOT NULL REFERENCES execution_environments(host_id), generation INTEGER NOT NULL,
 flavor TEXT NOT NULL CHECK(flavor IN ('codex','claude')), billing TEXT NOT NULL,
 launch_id TEXT NOT NULL UNIQUE, hub_session_id TEXT, native_thread_id TEXT,
 lineage TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'new',
 history_epoch INTEGER, cursor_seq INTEGER, cursor_at INTEGER, sse_cursor TEXT,
 coherent INTEGER NOT NULL DEFAULT 1, gateway_secret TEXT NOT NULL,
 gateway_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE native_dispatches (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), conversation_id TEXT NOT NULL REFERENCES native_sessions(conversation_id),
 local_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, envelope TEXT NOT NULL,
 billing TEXT NOT NULL, environment_id TEXT NOT NULL, generation INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared', auth_evidence TEXT NOT NULL DEFAULT '{}',
 native_turn_id TEXT, send_started_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE native_projection (
 conversation_id TEXT NOT NULL REFERENCES native_sessions(conversation_id),
 external_id TEXT NOT NULL, revision TEXT NOT NULL, message_id TEXT,
 payload TEXT NOT NULL, PRIMARY KEY(conversation_id,external_id)
);
CREATE TABLE native_permissions (
 approval_id TEXT PRIMARY KEY REFERENCES approvals(id), conversation_id TEXT NOT NULL,
 hub_session_id TEXT NOT NULL, request_id TEXT NOT NULL, decision TEXT,
 state TEXT NOT NULL DEFAULT 'pending', UNIQUE(conversation_id,hub_session_id,request_id)
);
CREATE INDEX native_dispatch_state ON native_dispatches(state);
INSERT INTO schema_version VALUES(27,unixepoch()*1000);
