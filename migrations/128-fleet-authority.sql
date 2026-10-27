-- These records are inactive until an explicit local owner consent is recorded.
-- Public directory history contains no local owner IDs or reusable credentials.
CREATE TABLE fleet_directory_history (
  owner_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  signed TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,digest),
  UNIQUE(owner_id,fleet_id,mutation_id)
);
CREATE TABLE fleet_binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner_id TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  head TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('controller','replica','handoff_pending','removed')),
  FOREIGN KEY(owner_id,head) REFERENCES fleet_directory_history(owner_id,digest)
);
CREATE TABLE fleet_local_consents (
  owner_id TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create','enroll','recover')),
  previous_head TEXT,
  accepted_head TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,consent_id)
);
CREATE TABLE fleet_peer_grants (
  owner_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  directory_digest TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  scope TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  PRIMARY KEY(owner_id,grant_id,peer_id)
);
CREATE TABLE fleet_admin_receipts (
  owner_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY(owner_id,mutation_id)
);
CREATE TABLE fleet_handoffs (
  owner_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  proposal TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','committed')),
  result TEXT,
  PRIMARY KEY(owner_id,digest)
);
CREATE TABLE fleet_command_receipts (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','completed','unknown','refused')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,command_id)
);
