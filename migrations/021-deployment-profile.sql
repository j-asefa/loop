-- A database belongs to one process topology and authorization boundary.
CREATE TABLE deployment_profile (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  profile TEXT NOT NULL CHECK(profile IN ('server','companion'))
);
INSERT INTO schema_version VALUES(21, unixepoch()*1000);
