-- One-time passes over historical Results, run by result-history.ts inside
-- the migration transaction. A recorded pass never runs again.
CREATE TABLE IF NOT EXISTS result_history_passes (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Append-only findings about sealed Results whose recorded facts disagree
-- with retained evidence. The Result itself, its digest and its references
-- are never changed; readers present the finding beside the original record.
CREATE TABLE IF NOT EXISTS result_defects (
  owner_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  defect TEXT NOT NULL,
  evidence TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, result_id, defect)
);
