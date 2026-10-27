-- The machine key belongs to the companion installation, not its URL or owner.
-- No fleet membership or peer authorization is created by this migration.
CREATE TABLE fleet_machine_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  machine_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
