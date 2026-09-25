CREATE TABLE agent_creations(
  owner_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,request_key)
);
INSERT INTO schema_version VALUES(11,unixepoch()*1000);
