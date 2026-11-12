-- Declare what each artifact is (D2): a `role` column set by the producer at
-- insert, never inferred later. Existing rows are backfilled by the
-- recognition rules below (D7); a row that fits none of them fails this
-- migration rather than being coerced. The database enforces the set on every
-- insert and update; SQLite cannot add a NOT NULL column without a default
-- inside the runner's single transaction, so triggers are the enforcement
-- mechanism (a rebuild would need foreign_keys off, which is a no-op inside
-- that transaction).
ALTER TABLE artifacts ADD COLUMN role TEXT;

-- The answer backfill correlates every artifact against its run's checkpoints;
-- without an index that is a full scan per row on real databases, so index the
-- lookup up front (agent_checkpoints has no index today).
CREATE INDEX IF NOT EXISTS agent_checkpoints_artifact
  ON agent_checkpoints(run_id, artifact_id);

-- One pass assigns every row, in a mutually exclusive order: file, upload,
-- import, answer, trace, snippet. (Separate passes would each scan the whole
-- artifacts table on real data, where metadata blobs make each scan costly.)
UPDATE artifacts SET role = CASE
  WHEN json_extract(metadata,'$.uploaded') IS 1 THEN 'file'
  WHEN run_id IS NULL AND json_extract(metadata,'$.upload') IS 1 THEN 'upload'
  WHEN COALESCE(json_extract(metadata,'$.origin'),'')='import' THEN 'import'
  WHEN EXISTS(SELECT 1 FROM agent_checkpoints cp
    WHERE cp.run_id=artifacts.run_id AND cp.artifact_id=artifacts.id) THEN 'answer'
  WHEN run_id IS NOT NULL THEN 'trace'
  ELSE 'snippet'
END;

-- SQL cannot raise conditionally outside a trigger, so a temporary guard
-- table's insert trigger checks the precondition: zero rows may be left
-- without a role or with an unknown one.
CREATE TABLE artifact_role_guard(checked INTEGER NOT NULL);
CREATE TRIGGER artifact_role_guard_check BEFORE INSERT ON artifact_role_guard
WHEN EXISTS(SELECT 1 FROM artifacts
  WHERE role IS NULL OR role NOT IN ('answer','trace','file','upload','import','snippet'))
BEGIN
  SELECT RAISE(ABORT, 'Artifacts without a declared role remain; this version requires one for every row.');
END;
INSERT INTO artifact_role_guard VALUES(1);
DROP TABLE artifact_role_guard;

CREATE TRIGGER artifact_role_insert BEFORE INSERT ON artifacts
WHEN NEW.role IS NULL OR NEW.role NOT IN ('answer','trace','file','upload','import','snippet')
BEGIN
  SELECT RAISE(ABORT, 'Unknown artifact role');
END;

CREATE TRIGGER artifact_role_update BEFORE UPDATE OF role ON artifacts
WHEN NEW.role IS NULL OR NEW.role NOT IN ('answer','trace','file','upload','import','snippet')
BEGIN
  SELECT RAISE(ABORT, 'Unknown artifact role');
END;