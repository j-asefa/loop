-- Reinstall Done triggers for databases opened during the API rollout.

DROP TRIGGER done_messages_update;
CREATE TRIGGER done_messages_update AFTER UPDATE ON messages
WHEN new.owner_id IS NOT old.owner_id OR new.conversation_id IS NOT old.conversation_id
  OR new.run_id IS NOT old.run_id OR new.role IS NOT old.role OR new.created_at IS NOT old.created_at
  OR json_extract(new.metadata,'$.progress') IS NOT json_extract(old.metadata,'$.progress')
  OR json_extract(new.metadata,'$.partial') IS NOT json_extract(old.metadata,'$.partial')
  OR ((new.content IS NOT old.content OR new.metadata IS NOT old.metadata)
    AND (json_extract(new.metadata,'$.partial') IS NOT 1 OR json_extract(old.metadata,'$.partial') IS NOT 1
      OR new.run_id IS NULL OR old.run_id IS NULL
      OR EXISTS(SELECT 1 FROM runs WHERE id IN (old.run_id,new.run_id) AND state='completed')))
BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||old.id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||new.id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

DROP TRIGGER done_folders_insert;
CREATE TRIGGER done_folders_insert AFTER INSERT ON folders BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=new.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=new.owner_id AND project_id=new.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=new.owner_id AND w.project_id=new.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

DROP TRIGGER done_folders_update;
CREATE TRIGGER done_folders_update AFTER UPDATE ON folders WHEN new.name IS NOT old.name OR new.kind IS NOT old.kind OR new.parent_id IS NOT old.parent_id OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=old.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=old.owner_id AND project_id=old.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=old.owner_id AND w.project_id=old.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=new.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=new.owner_id AND project_id=new.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=new.owner_id AND w.project_id=new.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

DROP TRIGGER done_folders_delete;
CREATE TRIGGER done_folders_delete AFTER DELETE ON folders BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=old.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=old.owner_id AND project_id=old.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=old.owner_id AND w.project_id=old.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

-- Reconcile any eligible answer edited before these triggers were installed.
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor)
SELECT 'done',key,owner_id,0 FROM done_card_candidates WHERE key IS NOT NULL AND owner_id IS NOT NULL
ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;

INSERT INTO schema_version(version,applied_at) VALUES(105,unixepoch()*1000);
