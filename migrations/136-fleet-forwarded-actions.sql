CREATE TABLE fleet_forwarded_actions (
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  route TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','completed','unknown','refused')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,command_id)
);
