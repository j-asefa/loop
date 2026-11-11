-- Artifact kinds are one closed enum (D1): a row may only carry a kind a
-- production code path writes. The database enforces the set on every insert
-- and update, and a database that already holds an unknown kind refuses this
-- migration (the runner rolls the whole startup transaction back). Unknown
-- kinds are never coerced.
-- SQL cannot raise conditionally outside a trigger, so a temporary guard
-- table's insert trigger checks the precondition.
CREATE TABLE artifact_kind_guard(checked INTEGER NOT NULL);
CREATE TRIGGER artifact_kind_guard_check BEFORE INSERT ON artifact_kind_guard
WHEN EXISTS(SELECT 1 FROM artifacts WHERE kind NOT IN ('markdown','image','github_pr','chart','table','diagram','file','conversation'))
BEGIN
  SELECT RAISE(ABORT, 'Artifacts with an unknown kind remain; this version writes only the declared kind set.');
END;
INSERT INTO artifact_kind_guard VALUES(1);
DROP TABLE artifact_kind_guard;

CREATE TRIGGER artifact_kind_insert BEFORE INSERT ON artifacts
WHEN NEW.kind NOT IN ('markdown','image','github_pr','chart','table','diagram','file','conversation')
BEGIN
  SELECT RAISE(ABORT, 'Unknown artifact kind');
END;

CREATE TRIGGER artifact_kind_update BEFORE UPDATE OF kind ON artifacts
WHEN NEW.kind NOT IN ('markdown','image','github_pr','chart','table','diagram','file','conversation')
BEGIN
  SELECT RAISE(ABORT, 'Unknown artifact kind');
END;
