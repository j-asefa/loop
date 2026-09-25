CREATE TABLE search_index_status(
  owner_id TEXT PRIMARY KEY,
  configuration TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO schema_version VALUES(14,unixepoch()*1000);
