CREATE TABLE pi_package_recovery (
  owner_id TEXT NOT NULL,
  project TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('user','project')),
  source TEXT NOT NULL,
  previous_source TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,project,scope,source)
);
INSERT INTO schema_version VALUES(44,unixepoch()*1000);
