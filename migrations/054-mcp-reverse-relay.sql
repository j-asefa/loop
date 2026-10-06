-- Docker can request tools from a paired laptop without opening a host port.
-- The laptop polls pending calls over the existing loopback-published Docker API.
CREATE TABLE mcp_reverse_catalog(
  peer_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  tools TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE mcp_reverse_calls(
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
CREATE INDEX mcp_reverse_pending ON mcp_reverse_calls(owner_id,peer_id,state,created_at);
INSERT INTO schema_version VALUES(54,unixepoch()*1000);
