-- Only newly requested asynchronous reviews opt in. Do not wake historical work.
CREATE TABLE review_continuations (
  review_id TEXT PRIMARY KEY REFERENCES code_reviews(id),
  owner_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL REFERENCES runs(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX review_continuations_parent ON review_continuations(parent_run_id);
