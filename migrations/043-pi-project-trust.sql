CREATE TABLE pi_project_trust (
  owner_id TEXT NOT NULL,
  project TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  trusted INTEGER NOT NULL CHECK(trusted IN (0,1)),
  decided_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,project)
);
INSERT INTO schema_version VALUES(43,unixepoch()*1000);
