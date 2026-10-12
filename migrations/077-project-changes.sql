-- A durable cursor for project projections. Source rows can disappear without
-- deleting their history; only deleting the project deletes its change stream.
CREATE TABLE project_changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (
    'result','prompt','approval_created','approval_resolved',
    'decision_created','decision_resolved','pr_update','saved','unsaved','label',
    'mail','brief_edit','tombstone')),
  ref TEXT NOT NULL,
  conversation_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX project_changes_cursor ON project_changes(owner_id, project_id, seq);

-- This is a history cursor, not a visible-items projection. Backfill retains
-- published/pinned records, including archived artifacts, as the PR 0 contract
-- requires. Consumers resolve current source state; a result/saved event does
-- not unarchive its source. Historical tombstones are deliberately not inferred.

-- Every kind='project' row owns a brief, even when it is nested. Other folders
-- inherit their nearest project; keep ownership on every edge of that walk.
CREATE VIEW project_change_folders AS
WITH RECURSIVE scope(owner_id,folder_id,project_id) AS (
  SELECT owner_id,id,id FROM folders WHERE kind='project'
  UNION
  SELECT f.owner_id,f.id,s.project_id FROM folders f
  JOIN scope s ON f.parent_id=s.folder_id AND f.owner_id=s.owner_id
  WHERE f.kind='folder'
) SELECT owner_id,folder_id,project_id FROM scope;

-- Share record-specific scope between the backfill, SQL publication/deletion
-- hooks and application writers. Never infer an old record's scope from a
-- newer run, or accept a project/conversation owned by somebody else.
-- PR 0's brief contract explicitly chooses conversation.project_id first,
-- then the record's run folder. A later turn with a different folder does not
-- move the conversation's brief history. Existing Saved/Feed scope is unchanged
-- and may differ; changing those readers is outside this additive feature.
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
) s JOIN project_change_folders f ON f.folder_id=s.project_id AND f.owner_id=s.owner_id;

-- Current record shapes when a folder of existing work enters a project.
CREATE VIEW project_change_entries AS
SELECT s.*,'result' kind FROM project_change_sources s
JOIN artifact_publications p ON s.source='artifact' AND p.artifact_id=s.ref
UNION ALL
SELECT s.*,'prompt' FROM project_change_sources s
JOIN messages m ON s.source='message' AND m.id=s.ref
WHERE m.role='user' AND json_extract(m.metadata,'$.automation') IS NULL
UNION ALL
SELECT s.*,'approval_created' FROM project_change_sources s WHERE s.source='approval'
UNION ALL
SELECT s.*,'approval_resolved' FROM project_change_sources s
JOIN approvals a ON s.source='approval' AND a.id=s.ref WHERE a.state<>'pending'
UNION ALL
SELECT s.*,'decision_created' FROM project_change_sources s WHERE s.source='decision'
UNION ALL
SELECT s.*,'decision_resolved' FROM project_change_sources s
JOIN native_decisions d ON s.source='decision' AND d.id=s.ref WHERE d.state NOT IN ('pending','deciding')
UNION ALL
SELECT s.*,'saved' FROM project_change_sources s
JOIN artifacts a ON s.source='artifact' AND a.id=s.ref WHERE a.pinned=1
UNION ALL
SELECT s.*,'saved' FROM project_change_sources s
JOIN message_bookmarks b ON s.source='message' AND b.message_id=s.ref AND b.owner_id=s.owner_id;

INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT s.owner_id,s.project_id,'result',s.ref,s.conversation_id,a.created_at
FROM artifact_publications p JOIN artifacts a ON a.id=p.artifact_id
JOIN project_change_sources s ON s.source='artifact' AND s.ref=a.id
ORDER BY p.sequence;

INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT s.owner_id,s.project_id,'prompt',s.ref,s.conversation_id,m.created_at
FROM messages m JOIN project_change_sources s ON s.source='message' AND s.ref=m.id
WHERE m.role='user' AND json_extract(m.metadata,'$.automation') IS NULL
ORDER BY m.created_at,m.rowid;

INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT s.owner_id,s.project_id,'approval_created',s.ref,s.conversation_id,a.created_at
FROM approvals a JOIN project_change_sources s ON s.source='approval' AND s.ref=a.id
ORDER BY a.created_at,a.rowid;

-- Approvals do not retain a decision timestamp. Creation time is the only
-- historical timestamp available; new decisions use their actual change time.
INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT s.owner_id,s.project_id,'approval_resolved',s.ref,s.conversation_id,a.created_at
FROM approvals a JOIN project_change_sources s ON s.source='approval' AND s.ref=a.id
WHERE a.state<>'pending'
ORDER BY a.created_at,a.rowid;

INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT s.owner_id,s.project_id,'decision_created',s.ref,s.conversation_id,d.created_at
FROM native_decisions d JOIN project_change_sources s ON s.source='decision' AND s.ref=d.id
ORDER BY d.created_at,d.rowid;

INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT s.owner_id,s.project_id,'decision_resolved',s.ref,s.conversation_id,d.created_at
FROM native_decisions d JOIN project_change_sources s ON s.source='decision' AND s.ref=d.id
WHERE d.state NOT IN ('pending','deciding')
ORDER BY d.created_at,d.rowid;

INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
SELECT owner_id,project_id,'saved',ref,conversation_id,at FROM (
  SELECT s.*,a.updated_at at FROM artifacts a
  JOIN project_change_sources s ON s.source='artifact' AND s.ref=a.id WHERE a.pinned=1
  UNION ALL
  SELECT s.*,b.created_at at FROM message_bookmarks b
  JOIN project_change_sources s ON s.source='message' AND s.ref=b.message_id AND s.owner_id=b.owner_id
) ORDER BY at,ref;

-- Publication, not inserting the running answer placeholder, advances results.
CREATE TRIGGER project_change_result AFTER INSERT ON artifact_publications BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT s.owner_id,s.project_id,'result',s.ref,s.conversation_id,CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)
  FROM project_change_sources s
  WHERE s.source='artifact' AND s.ref=new.artifact_id;
END;

-- SQL hooks also cover deletion through foreign-key cascades. Resolve scope
-- before the record disappears, without adding a foreign key back to it.
CREATE TRIGGER project_change_conversation_deleted BEFORE DELETE ON conversations BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'tombstone',ref,conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_sources WHERE source IN ('message','artifact')
    AND conversation_id=old.id AND owner_id=old.owner_id;
END;
CREATE TRIGGER project_change_message_deleted BEFORE DELETE ON messages BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'tombstone',ref,conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_sources WHERE source='message' AND ref=old.id;
END;
CREATE TRIGGER project_change_artifact_deleted BEFORE DELETE ON artifacts BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'tombstone',ref,conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_sources WHERE source='artifact' AND ref=old.id;
END;
CREATE TRIGGER project_change_artifact_archived AFTER UPDATE OF archived ON artifacts
WHEN new.archived=1 AND old.archived<>1 BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'tombstone',ref,conversation_id,new.updated_at
  FROM project_change_sources WHERE source='artifact' AND ref=new.id;
END;

CREATE TRIGGER project_change_artifact_restored AFTER UPDATE OF archived ON artifacts
WHEN old.archived=1 AND new.archived=0 BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'result',ref,conversation_id,new.updated_at
  FROM project_change_sources WHERE source='artifact' AND ref=new.id
    AND EXISTS(SELECT 1 FROM artifact_publications WHERE artifact_id=new.id);
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'saved',ref,conversation_id,new.updated_at
  FROM project_change_sources WHERE source='artifact' AND ref=new.id
    AND new.pinned=1 AND old.pinned=1;
END;

-- Edits change the text a citation resolves to. Running answer placeholders
-- still wait for publication, and automation is never an owner prompt.
CREATE TRIGGER project_change_artifact_edited AFTER UPDATE OF content,title ON artifacts
WHEN (new.content IS NOT old.content OR new.title IS NOT old.title)
  AND EXISTS(SELECT 1 FROM artifact_publications WHERE artifact_id=new.id) BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'result',ref,conversation_id,new.updated_at
  FROM project_change_sources WHERE source='artifact' AND ref=new.id;
END;
CREATE TRIGGER project_change_prompt_edited AFTER UPDATE OF content ON messages
WHEN new.content IS NOT old.content AND new.role='user'
  AND json_extract(new.metadata,'$.automation') IS NULL BEGIN
  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT owner_id,project_id,'prompt',ref,conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM project_change_sources WHERE source='message' AND ref=new.id;
END;

-- Filing and undo both update folder_id. Only a fallback to the artifact's own
-- folder can change its brief scope; conversation/run scope still wins. Moves
-- within one project are quiet. Moving out leaves a tombstone, while moving in
-- makes the existing publication (and save, if any) visible to the new cursor.
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
  LEFT JOIN project_change_folders destination ON destination.folder_id=new.folder_id AND destination.owner_id=new.owner_id
  WHERE previous.folder_id=old.folder_id AND previous.owner_id=new.owner_id
    AND previous.project_id IS NOT destination.project_id;

  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT new.owner_id,destination.project_id,'result',new.id,new.conversation_id,new.updated_at
  FROM project_change_folders destination
  LEFT JOIN project_change_folders previous ON previous.folder_id=old.folder_id AND previous.owner_id=new.owner_id
  WHERE destination.folder_id=new.folder_id AND destination.owner_id=new.owner_id
    AND destination.project_id IS NOT previous.project_id
    AND EXISTS(SELECT 1 FROM artifact_publications WHERE artifact_id=new.id);

  INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at)
  SELECT new.owner_id,destination.project_id,'saved',new.id,new.conversation_id,new.updated_at
  FROM project_change_folders destination
  LEFT JOIN project_change_folders previous ON previous.folder_id=old.folder_id AND previous.owner_id=new.owner_id
  WHERE destination.folder_id=new.folder_id AND destination.owner_id=new.owner_id
    AND destination.project_id IS NOT previous.project_id AND new.pinned=1;
END;

-- Reparenting an ordinary folder changes the scope of its existing records,
-- too. Nested projects are independent roots and stop the descendant walk.
CREATE TRIGGER project_change_folder_leaving BEFORE UPDATE OF parent_id ON folders
WHEN old.kind='folder' AND new.parent_id IS NOT old.parent_id
  AND (SELECT project_id FROM project_change_folders WHERE folder_id=old.id AND owner_id=old.owner_id)
    IS NOT (SELECT project_id FROM project_change_folders WHERE folder_id=new.parent_id AND owner_id=new.owner_id) BEGIN
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
  AND (SELECT project_id FROM project_change_folders WHERE folder_id=old.parent_id AND owner_id=old.owner_id)
    IS NOT (SELECT project_id FROM project_change_folders WHERE folder_id=new.parent_id AND owner_id=new.owner_id) BEGIN
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
        AND folder_id=COALESCE(new.project_id,s.fallback_folder_id)
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
        AND folder_id=COALESCE(old.project_id,s.fallback_folder_id)
    );
END;

INSERT INTO schema_version VALUES(77,unixepoch()*1000);
