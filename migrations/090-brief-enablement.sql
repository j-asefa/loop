-- Disabling before the first generation must not erase the enablement history.
ALTER TABLE brief_state ADD COLUMN ever_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE brief_state SET ever_enabled=1 WHERE enabled=1 OR current_version>0 OR last_run_at IS NOT NULL;
CREATE TRIGGER brief_enabled_insert AFTER INSERT ON brief_state WHEN new.enabled=1 BEGIN
  UPDATE brief_state SET ever_enabled=1 WHERE owner_id=new.owner_id AND project_id=new.project_id;
END;
CREATE TRIGGER brief_enabled_update AFTER UPDATE OF enabled ON brief_state WHEN new.enabled=1 BEGIN
  UPDATE brief_state SET ever_enabled=1 WHERE owner_id=new.owner_id AND project_id=new.project_id;
END;
INSERT INTO schema_version VALUES(90,unixepoch()*1000);
