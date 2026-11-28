CREATE TABLE bead_assignments (
  owner_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  generation TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','claiming','claimed','started','releasing','released','refused')),
  run_id TEXT,
  release_attempt TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,request_id)
);
CREATE UNIQUE INDEX bead_one_active_assignment
  ON bead_assignments(owner_id,store_id,bead_id)
  WHERE state NOT IN ('released','refused');
CREATE UNIQUE INDEX bead_assignment_run ON bead_assignments(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX bead_assignments_target ON bead_assignments(owner_id,store_id,bead_id,created_at);
