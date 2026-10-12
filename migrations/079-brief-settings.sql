ALTER TABLE brief_state ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE brief_state ADD COLUMN model TEXT;
ALTER TABLE brief_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1));
-- A generation is read-only provider work. Expiring its lease permits recovery
-- after a worker crash; the token fences a late completion from an older job.
ALTER TABLE brief_state ADD COLUMN generation_id TEXT;
ALTER TABLE brief_state ADD COLUMN lease_until INTEGER;
-- Cursor metadata also survives a pass with no authored change/version.
ALTER TABLE brief_state ADD COLUMN basis_since INTEGER;
ALTER TABLE brief_state ADD COLUMN unincorporated_before INTEGER;
CREATE INDEX brief_state_due ON brief_state(enabled,due_at);

-- Publications, saves and removals also arrive through SQL triggers, without
-- passing through recordChange. Schedule at the common append-only boundary.
CREATE TRIGGER project_brief_due AFTER INSERT ON project_changes
WHEN new.kind IN ('result','prompt','approval_resolved','decision_resolved','pr_update',
  'saved','unsaved','label','mail','brief_edit','tombstone') BEGIN
  UPDATE brief_state SET due_at=CASE WHEN due_at IS NULL
    THEN max(CAST(unixepoch('subsec')*1000 AS INTEGER),COALESCE(last_run_at+900000,0))
    ELSE min(due_at,max(CAST(unixepoch('subsec')*1000 AS INTEGER),COALESCE(last_run_at+900000,0))) END
  WHERE owner_id=new.owner_id AND project_id=new.project_id AND enabled=1;
END;

INSERT INTO schema_version VALUES(79,unixepoch()*1000);
