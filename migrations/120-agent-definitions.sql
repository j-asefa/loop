CREATE TABLE agent_definitions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('agent','team')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  markdown TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_definitions_owner ON agent_definitions(owner_id, updated_at DESC);
CREATE TABLE definition_creations (
  owner_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  team_id TEXT REFERENCES teams(id),
  PRIMARY KEY(owner_id, request_key)
);
INSERT INTO schema_version VALUES(120,unixepoch()*1000);
