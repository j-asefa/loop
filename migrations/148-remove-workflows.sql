-- Workflows are removed. Drop their tables only when they hold nothing: a
-- database with any workflow, version, step, workflow run or workflow child
-- run fails this migration, and the runner rolls back the whole startup
-- transaction. Refusing is deliberate: the records are never dropped silently
-- and never reach code that no longer understands them.
-- SQL cannot raise conditionally outside a trigger, so a temporary guard
-- table's insert trigger checks the precondition.
CREATE TABLE workflow_removal_guard(checked INTEGER NOT NULL);
CREATE TRIGGER workflow_removal_guard_check BEFORE INSERT ON workflow_removal_guard
WHEN EXISTS(SELECT 1 FROM workflows)
  OR EXISTS(SELECT 1 FROM workflow_versions)
  OR EXISTS(SELECT 1 FROM workflow_steps)
  OR EXISTS(SELECT 1 FROM runs WHERE kind='workflow')
  OR EXISTS(SELECT 1 FROM runs WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.workflowRun') END IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Workflow records remain (workflows, workflow_versions, workflow_steps, runs with kind=workflow, or runs started by a workflow step); this version no longer runs or keeps workflows.');
END;
INSERT INTO workflow_removal_guard VALUES(1);
DROP TABLE workflow_removal_guard;

DROP TABLE workflow_steps;
DROP TABLE workflow_versions;
DROP TABLE workflows;
