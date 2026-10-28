CREATE TABLE fleet_distribution_instances (
  owner_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL
);
-- The exact signed envelope is stored before sending. Repetition is limited to
-- directory acceptance, whose durable digest makes identical pushes idempotent.
CREATE TABLE fleet_distribution_work (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  directory_digest TEXT NOT NULL,
  request TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'directory' CHECK(protocol IN ('directory','pending')),
  PRIMARY KEY(owner_id,peer_id,directory_digest),
  FOREIGN KEY(owner_id,peer_id,directory_digest)
    REFERENCES fleet_distribution(owner_id,peer_id,directory_digest)
);

-- Verified checkpoints for a spent but not yet committed enrollment ceremony.
-- These never install a binding or grant. A known removal cancels only this
-- operation; unrelated existing local authority stays intact.
CREATE TABLE fleet_pending_directory (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'destination' CHECK(role='destination'),
  head TEXT NOT NULL,
  signed TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(owner_id,operation_id),
  FOREIGN KEY(owner_id,role,operation_id)
    REFERENCES fleet_enrollments(owner_id,role,operation_id)
);
