CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner_id TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_version VALUES(15,unixepoch()*1000);
