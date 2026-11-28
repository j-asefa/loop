CREATE TABLE project_bead_stores (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  store_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(owner_id, project_id)
);

CREATE TABLE bead_write_receipts (
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create', 'comment', 'close', 'dependency')),
  request_hash TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  source_result_id TEXT,
  completed_at INTEGER,
  PRIMARY KEY(owner_id, request_id)
);
CREATE INDEX bead_write_receipts_target
  ON bead_write_receipts(owner_id, store_id, bead_id, operation);
