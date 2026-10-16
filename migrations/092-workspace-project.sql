-- The default project owns work without an explicit project. Keep raw
-- folder assignments unchanged: null remains the workspace's root location.
CREATE TABLE workspace_projects(
  owner_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES folders(id) ON DELETE CASCADE
);

DROP VIEW project_change_folders;
CREATE VIEW project_change_folders AS
WITH RECURSIVE scope(owner_id,folder_id,project_id) AS (
  SELECT owner_id,id,id FROM folders WHERE kind='project'
  UNION
  SELECT owner_id,NULL,project_id FROM workspace_projects
  UNION
  SELECT f.owner_id,f.id,w.project_id FROM folders f
  JOIN workspace_projects w ON w.owner_id=f.owner_id
  WHERE f.kind='folder' AND f.parent_id IS NULL
  UNION
  SELECT f.owner_id,f.id,s.project_id FROM folders f
  JOIN scope s ON f.parent_id=s.folder_id AND f.owner_id=s.owner_id
  WHERE f.kind='folder'
) SELECT owner_id,folder_id,project_id FROM scope;

DROP VIEW project_change_sources;
CREATE VIEW project_change_sources AS
SELECT s.source,s.ref,s.owner_id,f.project_id,s.conversation_id,s.project_id folder_id,s.fallback_folder_id
FROM (
  SELECT 'artifact' source,a.id ref,a.owner_id,a.conversation_id,
    COALESCE(c.project_id,json_extract(r.payload,'$.folderId'),a.folder_id) project_id,
    COALESCE(json_extract(r.payload,'$.folderId'),a.folder_id) fallback_folder_id
  FROM artifacts a
  LEFT JOIN conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id
  LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    AND (a.conversation_id IS NULL OR r.conversation_id=a.conversation_id)
  WHERE a.conversation_id IS NULL OR c.id IS NOT NULL
  UNION ALL
  SELECT 'message',m.id,m.owner_id,m.conversation_id,
    COALESCE(c.project_id,json_extract(r.payload,'$.folderId')),json_extract(r.payload,'$.folderId')
  FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id AND r.conversation_id=m.conversation_id
  UNION ALL
  SELECT 'approval',a.id,a.owner_id,r.conversation_id,
    COALESCE(c.project_id,json_extract(r.payload,'$.folderId')),json_extract(r.payload,'$.folderId')
  FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
  LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=a.owner_id
  WHERE r.conversation_id IS NULL OR c.id IS NOT NULL
  UNION ALL
  SELECT 'decision',d.id,r.owner_id,d.conversation_id,
    COALESCE(c.project_id,json_extract(r.payload,'$.folderId')),json_extract(r.payload,'$.folderId')
  FROM native_decisions d JOIN runs r ON r.id=d.run_id AND r.conversation_id=d.conversation_id
  JOIN conversations c ON c.id=d.conversation_id AND c.owner_id=r.owner_id
) s JOIN project_change_folders f ON f.folder_id IS s.project_id AND f.owner_id=s.owner_id;

-- Null-safe scope comparisons keep moving into and out of Workspace
-- subject to the same tombstone and citation rules as named projects.
DROP TRIGGER project_change_artifact_moved;
DROP TRIGGER project_change_folder_leaving;
DROP TRIGGER project_change_folder_entering;
DROP TRIGGER project_change_conversation_leaving;
DROP TRIGGER project_change_conversation_entering;
CREATE TRIGGER project_change_artifact_moved AFTER UPDATE OF folder_id ON artifacts
WHEN new.folder_id IS NOT old.folder_id
  AND (new.conversation_id IS NULL OR EXISTS(
    SELECT 1 FROM conversations WHERE id=new.conversation_id AND owner_id=new.owner_id))
  AND COALESCE(
    (SELECT project_id FROM conversations WHERE id=new.conversation_id AND owner_id=new.owner_id),
    (SELECT json_extract(payload,'$.folderId') FROM runs WHERE id=new.run_id AND owner_id=new.owner_id
      AND (new.conversation_id IS NULL OR conversation_id=new.conversation_id))
  ) IS NULL BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT new.owner_id,previous.project_id,'tombstone',new.id,new.conversation_id,new.updated_at
  FROM project_change_folders previous
  LEFT JOIN project_change_folders destination ON destination.folder_id IS new.folder_id AND destination.owner_id=new.owner_id
  WHERE previous.folder_id IS old.folder_id AND previous.owner_id=new.owner_id
    AND previous.project_id IS NOT destination.project_id;

  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT new.owner_id,destination.project_id,'result',new.id,new.conversation_id,new.updated_at
  FROM project_change_folders destination
  LEFT JOIN project_change_folders previous ON previous.folder_id IS old.folder_id AND previous.owner_id=new.owner_id
  WHERE destination.folder_id IS new.folder_id AND destination.owner_id=new.owner_id
    AND destination.project_id IS NOT previous.project_id
    AND EXISTS(SELECT 1 FROM artifact_publications WHERE artifact_id=new.id);

  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT new.owner_id,destination.project_id,'saved',new.id,new.conversation_id,new.updated_at
  FROM project_change_folders destination
  LEFT JOIN project_change_folders previous ON previous.folder_id IS old.folder_id AND previous.owner_id=new.owner_id
  WHERE destination.folder_id IS new.folder_id AND destination.owner_id=new.owner_id
    AND destination.project_id IS NOT previous.project_id AND new.pinned=1;
END;

-- Reparenting an ordinary folder changes the scope of its existing records,
-- too. Nested projects are independent roots and stop the descendant walk.
CREATE TRIGGER project_change_folder_leaving BEFORE UPDATE OF parent_id ON folders
WHEN old.kind='folder' AND new.parent_id IS NOT old.parent_id
  AND (SELECT project_id FROM project_change_folders WHERE folder_id IS old.id AND owner_id=old.owner_id)
    IS NOT (SELECT project_id FROM project_change_folders WHERE folder_id IS new.parent_id AND owner_id=new.owner_id) BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'tombstone',ref,conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_sources WHERE owner_id=old.owner_id AND folder_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT old.id UNION SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
      WHERE f.owner_id=old.owner_id AND f.kind='folder'
    ) SELECT id FROM descendants
  );
END;
CREATE TRIGGER project_change_folder_entering AFTER UPDATE OF parent_id ON folders
WHEN new.kind='folder' AND new.parent_id IS NOT old.parent_id
  AND (SELECT project_id FROM project_change_folders WHERE folder_id IS old.parent_id AND owner_id=old.owner_id)
    IS NOT (SELECT project_id FROM project_change_folders WHERE folder_id IS new.parent_id AND owner_id=new.owner_id) BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,kind,ref,conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_entries WHERE owner_id=new.owner_id AND folder_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT new.id UNION SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
      WHERE f.owner_id=new.owner_id AND f.kind='folder'
    ) SELECT id FROM descendants
  );
END;

-- submit() can assign an existing unscoped conversation to a project. Its old
-- records enter that project too. Compare each record's own run/file fallback
-- to avoid replaying records that already belonged to the destination project.
CREATE TRIGGER project_change_conversation_leaving BEFORE UPDATE OF project_id ON conversations
WHEN new.project_id IS NOT old.project_id BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT s.owner_id,s.project_id,'tombstone',s.ref,s.conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_sources s
  WHERE s.conversation_id=old.id AND s.owner_id=old.owner_id
    AND s.project_id IS NOT (
      SELECT project_id FROM project_change_folders WHERE owner_id=new.owner_id
        AND folder_id IS COALESCE(new.project_id,s.fallback_folder_id)
    );
END;
CREATE TRIGGER project_change_conversation_entering AFTER UPDATE OF project_id ON conversations
WHEN new.project_id IS NOT old.project_id BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT s.owner_id,s.project_id,s.kind,s.ref,s.conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_entries s
  WHERE s.conversation_id=new.id AND s.owner_id=new.owner_id
    AND s.project_id IS NOT (
      SELECT project_id FROM project_change_folders WHERE owner_id=old.owner_id
        AND folder_id IS COALESCE(old.project_id,s.fallback_folder_id)
    );
END;

INSERT INTO schema_version VALUES(92,unixepoch()*1000);
