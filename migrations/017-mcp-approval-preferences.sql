CREATE TABLE mcp_preferences(
  owner_id TEXT PRIMARY KEY,
  approval_mode TEXT NOT NULL CHECK(approval_mode IN ('ask','allow'))
);
INSERT INTO schema_version VALUES(17,unixepoch()*1000);
