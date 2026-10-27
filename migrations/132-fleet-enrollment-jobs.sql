ALTER TABLE fleet_enrollments ADD COLUMN local_input_digest TEXT;
ALTER TABLE fleet_enrollments ADD COLUMN attempt_id TEXT;
ALTER TABLE fleet_enrollments ADD COLUMN receipt TEXT;
ALTER TABLE fleet_enrollments ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE fleet_enrollment_instances (
  owner_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL
);
CREATE TABLE fleet_admin_reservations (
  owner_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  revision_digest TEXT
);
