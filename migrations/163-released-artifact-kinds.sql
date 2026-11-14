-- Install the same historical-kind allowance for databases that already applied
-- artifact-kind-check. Preserve every existing artifact and its exact content.
DROP TRIGGER artifact_kind_insert;
DROP TRIGGER artifact_kind_update;
CREATE TRIGGER artifact_kind_insert BEFORE INSERT ON artifacts
WHEN NEW.kind NOT IN ('code','markdown','image','github_pr','chart','table','diagram','file','conversation')
BEGIN
  SELECT RAISE(ABORT, 'Unknown artifact kind');
END;
CREATE TRIGGER artifact_kind_update BEFORE UPDATE OF kind ON artifacts
WHEN NEW.kind NOT IN ('code','markdown','image','github_pr','chart','table','diagram','file','conversation')
BEGIN
  SELECT RAISE(ABORT, 'Unknown artifact kind');
END;
