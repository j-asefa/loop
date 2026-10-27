-- Only proof-bearing redemption writes nonce receipts and access credentials.
CREATE TABLE fleet_credential_issuer (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  issuer_session TEXT NOT NULL
);
CREATE TABLE fleet_credential_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  observed_at INTEGER NOT NULL
);
CREATE TABLE fleet_credential_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  issuer_session TEXT NOT NULL,
  expires_at_monotonic INTEGER NOT NULL
);
CREATE TABLE fleet_credentials (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  context TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX fleet_credentials_owner ON fleet_credentials(owner_id,peer_id,expires_at);
