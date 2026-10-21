-- Complete card invalidation. Keep the legacy prompt entity and publication
-- cursors; Saved additionally consumes message revisions. No history pruning.
-- Owner is part of a tombstone identity so an ownership change cannot erase
-- the former owner's removal or expose the new owner's data.
CREATE TABLE card_feed_revisions(
  revision INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL,
  object_id TEXT NOT NULL, owner_id TEXT NOT NULL, cursor INTEGER NOT NULL,
  UNIQUE(owner_id,entity,object_id)
);
INSERT INTO card_feed_revisions SELECT * FROM feed_revisions;
-- Keep existing triggers' references to the final table name while replacing
-- its uniqueness constraint inside the migration transaction.
PRAGMA legacy_alter_table=ON;
DROP TABLE feed_revisions;
ALTER TABLE card_feed_revisions RENAME TO feed_revisions;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX feed_revisions_owner ON feed_revisions(owner_id,entity,revision);
CREATE INDEX feed_revisions_watermark ON feed_revisions(owner_id,revision);
CREATE TABLE card_revision_domain(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);
INSERT INTO card_revision_domain VALUES(1,lower(hex(randomblob(24))));


-- Reverse edges make attachment authorization invalidation proportional to the
-- affected references, rather than parsing every prompt on each publish/save.
-- No foreign key to the target: disappearance/reappearance must still reconcile.
CREATE TABLE card_attachment_refs(
  owner_id TEXT NOT NULL, entity TEXT NOT NULL CHECK(entity IN ('artifact','message')),
  object_id TEXT NOT NULL, target_id TEXT NOT NULL,
  PRIMARY KEY(owner_id,entity,object_id,target_id)
);
CREATE INDEX card_attachment_refs_target ON card_attachment_refs(owner_id,target_id,entity,object_id);
CREATE INDEX card_artifact_object_link ON artifacts(owner_id,json_extract(metadata,'$.objectId'));
CREATE INDEX card_messages_owner_id ON messages(owner_id,id);
CREATE INDEX card_messages_conversation ON messages(owner_id,conversation_id,id);
CREATE INDEX card_conversations_project ON conversations(owner_id,project_id,id);
CREATE INDEX card_runs_folder ON runs(owner_id,json_extract(payload,'$.folderId'),id);
CREATE INDEX card_artifacts_owner_id ON artifacts(owner_id,id);
-- Relation IDs are globally unique, so these also cover old-owner removals
-- during ownership changes without scanning unrelated owners' histories.
CREATE INDEX card_messages_run ON messages(run_id,id);
CREATE INDEX card_runs_agent ON runs(agent_id,owner_id,id);
CREATE INDEX card_conversations_agent ON conversations(agent_id,owner_id,id);
CREATE INDEX card_artifacts_run ON artifacts(run_id,id);
CREATE INDEX card_artifacts_agent ON artifacts(agent_id,id);
CREATE INDEX card_artifacts_conversation ON artifacts(conversation_id,id);
CREATE INDEX card_artifacts_folder ON artifacts(folder_id,id);
CREATE INDEX card_folders_parent ON folders(parent_id,id);
INSERT INTO card_attachment_refs(owner_id,entity,object_id,target_id)
  SELECT source.owner_id,'message',source.id,CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END
  FROM messages source, json_each(CASE WHEN json_type(source.metadata,'$.attachments')='array'
    THEN json_extract(source.metadata,'$.attachments') ELSE '[]' END) j
  WHERE CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END IS NOT NULL
  ON CONFLICT(owner_id,entity,object_id,target_id) DO NOTHING;
CREATE TRIGGER card_message_refs_insert AFTER INSERT ON messages BEGIN
  INSERT INTO card_attachment_refs(owner_id,entity,object_id,target_id)
  SELECT new.owner_id,'message',new.id,CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END
  FROM json_each(CASE WHEN json_type(new.metadata,'$.attachments')='array'
    THEN json_extract(new.metadata,'$.attachments') ELSE '[]' END) j
  WHERE CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END IS NOT NULL
  ON CONFLICT(owner_id,entity,object_id,target_id) DO NOTHING;
END;
CREATE TRIGGER card_message_refs_update AFTER UPDATE OF metadata,owner_id ON messages
WHEN new.owner_id IS NOT old.owner_id OR json_extract(new.metadata,'$.attachments') IS NOT json_extract(old.metadata,'$.attachments') BEGIN
  DELETE FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='message' AND object_id=old.id;
  INSERT INTO card_attachment_refs(owner_id,entity,object_id,target_id)
  SELECT new.owner_id,'message',new.id,CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END
  FROM json_each(CASE WHEN json_type(new.metadata,'$.attachments')='array'
    THEN json_extract(new.metadata,'$.attachments') ELSE '[]' END) j
  WHERE CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END IS NOT NULL
  ON CONFLICT(owner_id,entity,object_id,target_id) DO NOTHING;
END;
CREATE TRIGGER card_message_refs_delete AFTER DELETE ON messages BEGIN
  DELETE FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='message' AND object_id=old.id;
END;
INSERT INTO card_attachment_refs(owner_id,entity,object_id,target_id)
  SELECT source.owner_id,'artifact',source.id,CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END
  FROM artifacts source, json_each(CASE WHEN json_type(source.metadata,'$.attachments')='array'
    THEN json_extract(source.metadata,'$.attachments') ELSE '[]' END) j
  WHERE CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END IS NOT NULL
  ON CONFLICT(owner_id,entity,object_id,target_id) DO NOTHING;
CREATE TRIGGER card_artifact_refs_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO card_attachment_refs(owner_id,entity,object_id,target_id)
  SELECT new.owner_id,'artifact',new.id,CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END
  FROM json_each(CASE WHEN json_type(new.metadata,'$.attachments')='array'
    THEN json_extract(new.metadata,'$.attachments') ELSE '[]' END) j
  WHERE CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END IS NOT NULL
  ON CONFLICT(owner_id,entity,object_id,target_id) DO NOTHING;
END;
CREATE TRIGGER card_artifact_refs_update AFTER UPDATE OF metadata,owner_id ON artifacts
WHEN new.owner_id IS NOT old.owner_id OR json_extract(new.metadata,'$.attachments') IS NOT json_extract(old.metadata,'$.attachments') BEGIN
  DELETE FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='artifact' AND object_id=old.id;
  INSERT INTO card_attachment_refs(owner_id,entity,object_id,target_id)
  SELECT new.owner_id,'artifact',new.id,CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END
  FROM json_each(CASE WHEN json_type(new.metadata,'$.attachments')='array'
    THEN json_extract(new.metadata,'$.attachments') ELSE '[]' END) j
  WHERE CASE WHEN j.type='object' THEN CASE WHEN json_type(j.value,'$.id')='text' THEN json_extract(j.value,'$.id') END END IS NOT NULL
  ON CONFLICT(owner_id,entity,object_id,target_id) DO NOTHING;
END;
CREATE TRIGGER card_artifact_refs_delete AFTER DELETE ON artifacts BEGIN
  DELETE FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='artifact' AND object_id=old.id;
END;

DROP TRIGGER prompt_feed_update;

CREATE TRIGGER prompt_feed_update AFTER UPDATE ON messages
WHEN (new.role='user' OR old.role='user') AND (new.role IS NOT old.role OR new.owner_id IS NOT old.owner_id
  OR new.conversation_id IS NOT old.conversation_id OR new.run_id IS NOT old.run_id
  OR new.created_at IS NOT old.created_at
  OR json_extract(new.metadata,'$.personal') IS NOT json_extract(old.metadata,'$.personal')
  OR json_type(new.metadata,'$.personal') IS NOT json_type(old.metadata,'$.personal')
  OR json_extract(new.metadata,'$.backend') IS NOT json_extract(old.metadata,'$.backend')
  OR json_extract(new.metadata,'$.sourceMessage') IS NOT json_extract(old.metadata,'$.sourceMessage')
  OR json_extract(new.metadata,'$.attachments') IS NOT json_extract(old.metadata,'$.attachments')
  OR ((new.content IS NOT old.content OR new.metadata IS NOT old.metadata)
    AND (json_extract(new.metadata,'$.partial') IS NOT 1 OR json_extract(old.metadata,'$.partial') IS NOT 1)))
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  VALUES('prompt',old.id,old.owner_id,old.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  VALUES('prompt',new.id,new.owner_id,new.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_message_update AFTER UPDATE ON messages
WHEN (new.role<>'user' OR old.role<>'user') AND EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.message_id=new.id)
  AND (new.role IS NOT old.role OR new.owner_id IS NOT old.owner_id
  OR new.conversation_id IS NOT old.conversation_id OR new.run_id IS NOT old.run_id
  OR new.created_at IS NOT old.created_at
  OR json_extract(new.metadata,'$.personal') IS NOT json_extract(old.metadata,'$.personal')
  OR json_type(new.metadata,'$.personal') IS NOT json_type(old.metadata,'$.personal')
  OR json_extract(new.metadata,'$.backend') IS NOT json_extract(old.metadata,'$.backend')
  OR json_extract(new.metadata,'$.sourceMessage') IS NOT json_extract(old.metadata,'$.sourceMessage')
  OR json_extract(new.metadata,'$.attachments') IS NOT json_extract(old.metadata,'$.attachments')
  OR ((new.content IS NOT old.content OR new.metadata IS NOT old.metadata)
    AND (json_extract(new.metadata,'$.partial') IS NOT 1 OR json_extract(old.metadata,'$.partial') IS NOT 1)))
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  VALUES('message',old.id,old.owner_id,old.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  VALUES('message',new.id,new.owner_id,new.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_message_delete BEFORE DELETE ON messages
WHEN old.role<>'user' AND EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.message_id=old.id)
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  VALUES('message',old.id,old.owner_id,old.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_owner AFTER UPDATE OF owner_id ON artifacts
WHEN new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  VALUES('artifact',old.id,old.owner_id,old.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_insert_refs AFTER INSERT ON artifacts
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='message' AND target_id=new.id UNION SELECT json_extract(new.metadata,'$.messageId')))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id<>new.id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='artifact' AND target_id=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_delete_refs BEFORE DELETE ON artifacts
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='message' AND target_id=old.id UNION SELECT json_extract(old.metadata,'$.messageId')))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id<>old.id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='artifact' AND target_id=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_update_refs AFTER UPDATE OF pinned,archived,metadata,owner_id,conversation_id ON artifacts
WHEN new.pinned IS NOT old.pinned OR new.archived IS NOT old.archived OR new.owner_id IS NOT old.owner_id
    OR new.conversation_id IS NOT old.conversation_id
    OR json_extract(new.metadata,'$.messageId') IS NOT json_extract(old.metadata,'$.messageId')
    OR json_extract(new.metadata,'$.objectId') IS NOT json_extract(old.metadata,'$.objectId')
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='message' AND target_id=old.id UNION SELECT json_extract(old.metadata,'$.messageId')))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id<>old.id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='artifact' AND target_id=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='message' AND target_id=new.id UNION SELECT json_extract(new.metadata,'$.messageId')))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id<>new.id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='artifact' AND target_id=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_message_bookmark_insert AFTER INSERT ON message_bookmarks
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN (SELECT role FROM messages WHERE id=new.message_id)='user' THEN 'prompt' ELSE 'message' END,
    new.message_id,new.owner_id,COALESCE((SELECT rowid FROM messages WHERE id=new.message_id),0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_bookmarks_insert AFTER INSERT ON artifact_bookmarks
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_publications_insert AFTER INSERT ON artifact_publications
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_label_insert AFTER INSERT ON saved_labels
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN substr(new.item_key,1,2)='a:' THEN 'artifact'
      WHEN (SELECT role FROM messages WHERE id=substr(new.item_key,3))='user' THEN 'prompt' ELSE 'message' END,
      substr(new.item_key,3),new.owner_id,COALESCE(
      CASE WHEN substr(new.item_key,1,2)='a:' THEN (SELECT rowid FROM artifacts WHERE id=substr(new.item_key,3))
      ELSE (SELECT rowid FROM messages WHERE id=substr(new.item_key,3)) END,0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_message_bookmark_leaving BEFORE UPDATE OF message_id,owner_id ON message_bookmarks
WHEN new.message_id IS NOT old.message_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN (SELECT role FROM messages WHERE id=old.message_id)='user' THEN 'prompt' ELSE 'message' END,
    old.message_id,old.owner_id,COALESCE((SELECT rowid FROM messages WHERE id=old.message_id),0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_message_bookmark_update AFTER UPDATE ON message_bookmarks
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN (SELECT role FROM messages WHERE id=new.message_id)='user' THEN 'prompt' ELSE 'message' END,
    new.message_id,new.owner_id,COALESCE((SELECT rowid FROM messages WHERE id=new.message_id),0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_bookmarks_update AFTER UPDATE ON artifact_bookmarks
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_publications_update AFTER UPDATE ON artifact_publications
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_label_update AFTER UPDATE ON saved_labels
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN substr(new.item_key,1,2)='a:' THEN 'artifact'
      WHEN (SELECT role FROM messages WHERE id=substr(new.item_key,3))='user' THEN 'prompt' ELSE 'message' END,
      substr(new.item_key,3),new.owner_id,COALESCE(
      CASE WHEN substr(new.item_key,1,2)='a:' THEN (SELECT rowid FROM artifacts WHERE id=substr(new.item_key,3))
      ELSE (SELECT rowid FROM messages WHERE id=substr(new.item_key,3)) END,0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_message_bookmark_delete AFTER DELETE ON message_bookmarks
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN (SELECT role FROM messages WHERE id=old.message_id)='user' THEN 'prompt' ELSE 'message' END,
    old.message_id,old.owner_id,COALESCE((SELECT rowid FROM messages WHERE id=old.message_id),0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_bookmarks_delete AFTER DELETE ON artifact_bookmarks
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_publications_delete AFTER DELETE ON artifact_publications
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_label_delete AFTER DELETE ON saved_labels
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN substr(old.item_key,1,2)='a:' THEN 'artifact'
      WHEN (SELECT role FROM messages WHERE id=substr(old.item_key,3))='user' THEN 'prompt' ELSE 'message' END,
      substr(old.item_key,3),old.owner_id,COALESCE(
      CASE WHEN substr(old.item_key,1,2)='a:' THEN (SELECT rowid FROM artifacts WHERE id=substr(old.item_key,3))
      ELSE (SELECT rowid FROM messages WHERE id=substr(old.item_key,3)) END,0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

DROP TRIGGER run_feed_update;

CREATE TRIGGER run_feed_update AFTER UPDATE OF state,error,payload,kind,agent_id,conversation_id,owner_id ON runs
WHEN new.state IS NOT old.state OR new.error IS NOT old.error OR new.payload IS NOT old.payload
  OR new.kind IS NOT old.kind OR new.agent_id IS NOT old.agent_id
  OR new.conversation_id IS NOT old.conversation_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.run_id=new.id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.run_id=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_run_delete BEFORE DELETE ON runs
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.run_id=old.id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.run_id=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_delegation_insert AFTER INSERT ON delegations
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.run_id=new.child_run_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_checkpoint_insert AFTER INSERT ON agent_checkpoints
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.run_id=new.run_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_delegation_delete BEFORE DELETE ON delegations
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.run_id=old.child_run_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_checkpoint_delete BEFORE DELETE ON agent_checkpoints
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.run_id=old.run_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_delegation_update AFTER UPDATE OF child_run_id ON delegations
WHEN new.child_run_id IS NOT old.child_run_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.run_id IN (old.child_run_id,new.child_run_id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_checkpoint_update AFTER UPDATE OF stage,artifact_id,run_id ON agent_checkpoints
WHEN new.stage IS NOT old.stage OR new.artifact_id IS NOT old.artifact_id OR new.run_id IS NOT old.run_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.run_id IN (old.run_id,new.run_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

DROP TRIGGER agent_feed_update;

CREATE TRIGGER agent_feed_update AFTER UPDATE OF name,provider,owner_id ON agents
WHEN new.name IS NOT old.name OR new.provider IS NOT old.provider OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.agent_id=new.id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND m.id IN (
      SELECT mm.id FROM runs rr CROSS JOIN messages mm
        ON mm.owner_id=rr.owner_id AND mm.run_id=rr.id WHERE rr.agent_id=new.id
      UNION
      SELECT mm.id FROM conversations cc CROSS JOIN messages mm
        ON mm.owner_id=cc.owner_id AND mm.conversation_id=cc.id WHERE cc.agent_id=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_agent_delete BEFORE DELETE ON agents
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.agent_id=old.id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND m.id IN (
      SELECT mm.id FROM runs rr CROSS JOIN messages mm
        ON mm.owner_id=rr.owner_id AND mm.run_id=rr.id WHERE rr.agent_id=old.id
      UNION
      SELECT mm.id FROM conversations cc CROSS JOIN messages mm
        ON mm.owner_id=cc.owner_id AND mm.conversation_id=cc.id WHERE cc.agent_id=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_conversation_update AFTER UPDATE OF title,project_id,team_id,agent_id,owner_id ON conversations
WHEN new.title IS NOT old.title OR new.project_id IS NOT old.project_id
    OR new.team_id IS NOT old.team_id OR new.agent_id IS NOT old.agent_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.conversation_id=new.id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.conversation_id=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_conversation_delete BEFORE DELETE ON conversations
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.conversation_id=old.id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.conversation_id=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_folder_leaving BEFORE UPDATE OF parent_id,kind,name,owner_id ON folders
WHEN new.parent_id IS NOT old.parent_id OR new.kind IS NOT old.kind OR new.name IS NOT old.name OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (
      SELECT mm.id FROM conversations cc CROSS JOIN messages mm
        ON mm.owner_id=cc.owner_id AND mm.conversation_id=cc.id
        WHERE cc.owner_id=old.owner_id AND cc.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
      UNION
      SELECT mm.id FROM runs rr CROSS JOIN messages mm
        ON mm.owner_id=rr.owner_id AND mm.run_id=rr.id
        WHERE rr.owner_id=old.owner_id AND json_extract(rr.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT +id FROM subtree)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM workspace_projects wp CROSS JOIN artifacts a WHERE wp.owner_id=old.owner_id AND wp.project_id=old.id AND a.owner_id=wp.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=old.owner_id AND w.project_id=old.id AND f.folder_id IS a.folder_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM workspace_projects wp CROSS JOIN messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE wp.owner_id=old.owner_id AND wp.project_id=old.id AND m.owner_id=wp.owner_id AND (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=old.owner_id AND w.project_id=old.id AND f.folder_id IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_folder_entering AFTER UPDATE OF parent_id,kind,name,owner_id ON folders
WHEN new.parent_id IS NOT old.parent_id OR new.kind IS NOT old.kind OR new.name IS NOT old.name OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (
      SELECT mm.id FROM conversations cc CROSS JOIN messages mm
        ON mm.owner_id=cc.owner_id AND mm.conversation_id=cc.id
        WHERE cc.owner_id=new.owner_id AND cc.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
      UNION
      SELECT mm.id FROM runs rr CROSS JOIN messages mm
        ON mm.owner_id=rr.owner_id AND mm.run_id=rr.id
        WHERE rr.owner_id=new.owner_id AND json_extract(rr.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT +id FROM subtree)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM workspace_projects wp CROSS JOIN artifacts a WHERE wp.owner_id=new.owner_id AND wp.project_id=new.id AND a.owner_id=wp.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=new.owner_id AND w.project_id=new.id AND f.folder_id IS a.folder_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM workspace_projects wp CROSS JOIN messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE wp.owner_id=new.owner_id AND wp.project_id=new.id AND m.owner_id=wp.owner_id AND (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=new.owner_id AND w.project_id=new.id AND f.folder_id IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_folder_insert AFTER INSERT ON folders
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (
      SELECT mm.id FROM conversations cc CROSS JOIN messages mm
        ON mm.owner_id=cc.owner_id AND mm.conversation_id=cc.id
        WHERE cc.owner_id=new.owner_id AND cc.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
      UNION
      SELECT mm.id FROM runs rr CROSS JOIN messages mm
        ON mm.owner_id=rr.owner_id AND mm.run_id=rr.id
        WHERE rr.owner_id=new.owner_id AND json_extract(rr.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT +id FROM subtree)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM workspace_projects wp CROSS JOIN artifacts a WHERE wp.owner_id=new.owner_id AND wp.project_id=new.id AND a.owner_id=wp.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=new.owner_id AND w.project_id=new.id AND f.folder_id IS a.folder_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM workspace_projects wp CROSS JOIN messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE wp.owner_id=new.owner_id AND wp.project_id=new.id AND m.owner_id=wp.owner_id AND (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=new.owner_id AND w.project_id=new.id AND f.folder_id IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_folder_delete BEFORE DELETE ON folders
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (
      SELECT mm.id FROM conversations cc CROSS JOIN messages mm
        ON mm.owner_id=cc.owner_id AND mm.conversation_id=cc.id
        WHERE cc.owner_id=old.owner_id AND cc.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM subtree)
      UNION
      SELECT mm.id FROM runs rr CROSS JOIN messages mm
        ON mm.owner_id=rr.owner_id AND mm.run_id=rr.id
        WHERE rr.owner_id=old.owner_id AND json_extract(rr.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT +id FROM subtree)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM workspace_projects wp CROSS JOIN artifacts a WHERE wp.owner_id=old.owner_id AND wp.project_id=old.id AND a.owner_id=wp.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=old.owner_id AND w.project_id=old.id AND f.folder_id IS a.folder_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM workspace_projects wp CROSS JOIN messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE wp.owner_id=old.owner_id AND wp.project_id=old.id AND m.owner_id=wp.owner_id AND (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND EXISTS(SELECT 1 FROM workspace_projects w JOIN project_change_folders f
      ON f.owner_id=w.owner_id AND f.project_id=w.project_id
      WHERE w.owner_id=old.owner_id AND w.project_id=old.id AND f.folder_id IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_workspace_insert AFTER INSERT ON workspace_projects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_object_insert AFTER INSERT ON objects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='message'
      WHERE fa.owner_id=new.owner_id AND json_extract(fa.metadata,'$.objectId')=new.id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='artifact'
      WHERE fa.owner_id=new.owner_id AND json_extract(fa.metadata,'$.objectId')=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_object_insert AFTER INSERT ON artifact_objects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='message' AND target_id=new.artifact_id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='artifact' AND target_id=new.artifact_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_workspace_update AFTER UPDATE ON workspace_projects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_object_update AFTER UPDATE ON objects
WHEN new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='message'
      WHERE fa.owner_id=new.owner_id AND json_extract(fa.metadata,'$.objectId')=new.id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='artifact'
      WHERE fa.owner_id=new.owner_id AND json_extract(fa.metadata,'$.objectId')=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_object_update AFTER UPDATE ON artifact_objects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=new.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='message' AND target_id=new.artifact_id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=new.owner_id AND entity='artifact' AND target_id=new.artifact_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_workspace_delete BEFORE DELETE ON workspace_projects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_object_delete BEFORE DELETE ON objects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='message'
      WHERE fa.owner_id=old.owner_id AND json_extract(fa.metadata,'$.objectId')=old.id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='artifact'
      WHERE fa.owner_id=old.owner_id AND json_extract(fa.metadata,'$.objectId')=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_object_delete BEFORE DELETE ON artifact_objects
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='message' AND target_id=old.artifact_id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='artifact' AND target_id=old.artifact_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;


CREATE TRIGGER card_object_leaving BEFORE UPDATE ON objects
WHEN new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='message'
      WHERE fa.owner_id=old.owner_id AND json_extract(fa.metadata,'$.objectId')=old.id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id IN (SELECT refs.object_id FROM artifacts fa CROSS JOIN card_attachment_refs refs
      ON refs.target_id=fa.id AND refs.owner_id=fa.owner_id AND refs.entity='artifact'
      WHERE fa.owner_id=old.owner_id AND json_extract(fa.metadata,'$.objectId')=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_object_leaving BEFORE UPDATE ON artifact_objects
WHEN new.owner_id IS NOT old.owner_id OR new.artifact_id IS NOT old.artifact_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='message' AND target_id=old.artifact_id))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=old.owner_id AND entity='artifact' AND target_id=old.artifact_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_workspace_leaving BEFORE UPDATE ON workspace_projects
WHEN new.owner_id IS NOT old.owner_id OR new.project_id IS NOT old.project_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.owner_id=old.owner_id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_publications_leaving BEFORE UPDATE ON artifact_publications
WHEN new.artifact_id IS NOT old.artifact_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_artifact_bookmarks_leaving BEFORE UPDATE ON artifact_bookmarks
WHEN new.artifact_id IS NOT old.artifact_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_label_leaving BEFORE UPDATE ON saved_labels
WHEN new.owner_id IS NOT old.owner_id OR new.item_key IS NOT old.item_key
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES(CASE WHEN substr(old.item_key,1,2)='a:' THEN 'artifact'
      WHEN (SELECT role FROM messages WHERE id=substr(old.item_key,3))='user' THEN 'prompt' ELSE 'message' END,
      substr(old.item_key,3),old.owner_id,COALESCE(
      CASE WHEN substr(old.item_key,1,2)='a:' THEN (SELECT rowid FROM artifacts WHERE id=substr(old.item_key,3))
      ELSE (SELECT rowid FROM messages WHERE id=substr(old.item_key,3)) END,0))
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

-- Membership and public display changes stay visible even on a partial result.
DROP TRIGGER artifact_feed_update;
CREATE TRIGGER artifact_feed_update AFTER UPDATE ON artifacts
WHEN ((new.content IS NOT old.content OR new.metadata IS NOT old.metadata OR new.updated_at IS NOT old.updated_at)
  AND (json_extract(new.metadata,'$.partial') IS NOT 1 OR json_extract(old.metadata,'$.partial') IS NOT 1))
  OR new.pinned IS NOT old.pinned
  OR new.archived IS NOT old.archived
  OR new.feed_hidden IS NOT old.feed_hidden
  OR new.folder_id IS NOT old.folder_id
  OR new.kind IS NOT old.kind
  OR new.title IS NOT old.title
  OR new.version IS NOT old.version
  OR new.owner_id IS NOT old.owner_id
  OR new.agent_id IS NOT old.agent_id
  OR new.conversation_id IS NOT old.conversation_id
  OR new.run_id IS NOT old.run_id
  OR new.created_at IS NOT old.created_at
  OR json_extract(new.metadata,'$.model') IS NOT json_extract(old.metadata,'$.model')
  OR json_extract(new.metadata,'$.resolvedModel') IS NOT json_extract(old.metadata,'$.resolvedModel')
  OR json_extract(new.metadata,'$.tool') IS NOT json_extract(old.metadata,'$.tool')
  OR json_extract(new.metadata,'$.origin') IS NOT json_extract(old.metadata,'$.origin')
  OR json_extract(new.metadata,'$.upload') IS NOT json_extract(old.metadata,'$.upload')
  OR json_extract(new.metadata,'$.uploaded') IS NOT json_extract(old.metadata,'$.uploaded')
  OR json_extract(new.metadata,'$.mime') IS NOT json_extract(old.metadata,'$.mime')
  OR json_extract(new.metadata,'$.name') IS NOT json_extract(old.metadata,'$.name')
  OR json_extract(new.metadata,'$.messageId') IS NOT json_extract(old.metadata,'$.messageId')
  OR json_extract(new.metadata,'$.attachments') IS NOT json_extract(old.metadata,'$.attachments')
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES('artifact',new.id,new.owner_id,new.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;


-- Explicit UPSERT keeps its conflict handling inside outer UPSERT/IGNORE writes.
-- OR REPLACE in a trigger inherits those callers' conflict policy.
DROP TRIGGER artifact_feed_insert;
CREATE TRIGGER artifact_feed_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('artifact',new.id,new.owner_id,new.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
DROP TRIGGER artifact_feed_delete;
CREATE TRIGGER artifact_feed_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('artifact',old.id,old.owner_id,old.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
DROP TRIGGER prompt_feed_insert;
CREATE TRIGGER prompt_feed_insert AFTER INSERT ON messages WHEN new.role='user' BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('prompt',new.id,new.owner_id,new.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
DROP TRIGGER prompt_feed_delete;
CREATE TRIGGER prompt_feed_delete AFTER DELETE ON messages WHEN old.role='user' BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('prompt',old.id,old.owner_id,old.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

-- Establish revisions only for historical non-user bookmarks; existing prompt
-- revisions were copied unchanged above. Do not invent content timestamps.
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT CASE WHEN m.role='user' THEN 'prompt' ELSE 'message' END,m.id,m.owner_id,m.rowid
  FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
  LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
  WHERE (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks mb WHERE mb.message_id=m.id AND mb.owner_id=m.owner_id))
    AND (m.role<>'user')
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
INSERT INTO schema_version VALUES(97,unixepoch()*1000);
