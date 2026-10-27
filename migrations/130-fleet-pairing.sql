CREATE TABLE fleet_device_store (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner_id TEXT NOT NULL
);
CREATE TABLE fleet_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL,
  max_expires INTEGER NOT NULL
);
CREATE TABLE fleet_pairing_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  observed_at INTEGER NOT NULL
);
CREATE TABLE fleet_pairing_ceremonies (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  scope TEXT NOT NULL,
  expected_head TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('enroll','repair','recover')),
  device_hash TEXT UNIQUE,
  enrollment_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','device','enrollment','cancelled')),
  operation_id TEXT,
  payload_digest TEXT,
  result TEXT,
  UNIQUE(owner_id,operation_id)
);
