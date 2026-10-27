-- Public signed requests never contain a device-pairing capability or cookie.
-- Only source records may retain the sealed enrollment capability for an
-- explicitly requested retry of the same operation.
CREATE TABLE fleet_enrollments (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('source','destination')),
  request_digest TEXT NOT NULL,
  request TEXT NOT NULL,
  capability TEXT,
  prepared TEXT,
  committed TEXT,
  state TEXT NOT NULL CHECK(state IN ('ready','preparing','uncertain','prepared','published','complete','cancelled')),
  PRIMARY KEY(owner_id,role,operation_id)
);
CREATE TABLE fleet_distribution (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  directory_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','acked','incompatible')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner_id,peer_id,directory_digest)
);
