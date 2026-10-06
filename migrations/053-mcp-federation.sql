-- A source keeps its own MCP credentials. Peers receive a scoped relay token,
-- and every forwarded effect has a durable identity on the source as well.
CREATE TABLE mcp_federation_peers(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(owner_id,peer_id)
);
CREATE TABLE mcp_federation_calls(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(peer_id,run_key,request_key)
);
INSERT INTO schema_version VALUES(53,unixepoch()*1000);
