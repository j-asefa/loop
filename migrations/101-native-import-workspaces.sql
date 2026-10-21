-- Keep preparation recoverable even if a native fork has an uncertain outcome
-- or the transaction that imports its result fails. Fork keys are command IDs;
-- desktop keys identify the harness/native session/destination. Neither path replays effects.
CREATE TABLE native_import_workspaces (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fork','desktop')),
  import_key TEXT NOT NULL,
  source TEXT NOT NULL,
  harness TEXT NOT NULL,
  project TEXT NOT NULL,
  agent_id TEXT PRIMARY KEY NOT NULL,
  workspace TEXT,
  created_at INTEGER NOT NULL,
  imported_at INTEGER
);
-- A completed import retains its preparation record. A later handoff after a
-- harness switch can prepare a new agent without reusing the consumed identity.
CREATE UNIQUE INDEX native_import_pending ON native_import_workspaces(owner_id,kind,import_key) WHERE imported_at IS NULL;
INSERT INTO schema_version VALUES(101,unixepoch()*1000);
