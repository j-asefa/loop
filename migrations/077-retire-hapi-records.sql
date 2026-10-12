-- HAPI execution was removed from the product and its code is deleted. Its
-- history stays; this makes the remaining records inert so no code needs to
-- recognize them. Nothing is deleted.

-- Runs still active stop here, once, instead of on every worker tick. Their
-- input and any uncertain dispatch are never replayed. (archiveHapiRuns.)
UPDATE approvals SET state='rejected'
WHERE state='pending' AND run_id IN (
  SELECT id FROM runs WHERE state IN ('queued','running','pausing','paused','awaiting_approval')
    AND (json_extract(payload,'$.execution.backend') IS 'hapi'
      OR EXISTS(SELECT 1 FROM native_dispatches d WHERE d.run_id=runs.id)));
UPDATE runs SET state='interrupted',worker_id=NULL,heartbeat=NULL,
  error='HAPI execution was removed. This work was not replayed; start a new native conversation to continue it.',
  updated_at=unixepoch()*1000,
  active_ms=active_ms+CASE WHEN active_since IS NULL THEN 0
    ELSE max(0,min(unixepoch()*1000,COALESCE(heartbeat,unixepoch()*1000))-active_since) END,
  active_since=NULL
WHERE state IN ('queued','running','pausing','paused','awaiting_approval')
  AND (json_extract(payload,'$.execution.backend') IS 'hapi'
    OR EXISTS(SELECT 1 FROM native_dispatches d WHERE d.run_id=runs.id));

-- Archived connections stay disconnected and stop presenting as subscription
-- runtimes, so deleting one does not try to sign out of a runtime that is gone.
-- Agents on them are refused like any disconnected connection.
UPDATE connections SET status='disconnected',metadata=json_remove(metadata,'$.authMode')
WHERE json_extract(metadata,'$.backend')='hapi';

-- HAPI conversations defaulted to inclusion in memory recall; others default
-- to excluded. Record that default explicitly so recall does not change.
INSERT OR IGNORE INTO memory_policy(owner_id,scope,enabled)
SELECT owner_id,'conversation:'||id,1 FROM conversations WHERE execution_backend='hapi';

INSERT INTO schema_version VALUES(77,unixepoch()*1000);
