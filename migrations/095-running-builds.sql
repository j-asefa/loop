CREATE TABLE deployment_instances (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('api','worker')),
  build TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  stopped_at INTEGER
);
CREATE TABLE checkout_build_targets (
  checkout_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  ancestors TEXT NOT NULL
);
CREATE INDEX checkout_build_targets_owner ON checkout_build_targets(owner_id,run_id);
CREATE TABLE deployment_observations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  checkout_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  instances TEXT NOT NULL,
  signature TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX deployment_observations_project ON deployment_observations(owner_id,project_id,observed_at DESC);
INSERT INTO schema_version VALUES(95,unixepoch()*1000);
