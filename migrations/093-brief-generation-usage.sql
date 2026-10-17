-- Generation accounting is separate from brief versions: a paid request can
-- leave the record unchanged, fail validation, or lose its generation lease.
CREATE TABLE brief_generation_usage (
  generation_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  usage TEXT NOT NULL
);
CREATE INDEX brief_generation_usage_latest
  ON brief_generation_usage(owner_id, project_id, started_at DESC);

INSERT INTO schema_version VALUES(93,unixepoch()*1000);
