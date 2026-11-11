DROP TABLE artifact_objects;
CREATE TABLE artifact_objects(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),owner_id TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,object_key TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,checksum TEXT NOT NULL,UNIQUE(run_id,call_id));

-- Preserve current projection and event triggers when removing key uniqueness.
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

CREATE TRIGGER card_reader_artifact_objects_delete_old BEFORE DELETE ON artifact_objects

BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_insert_new AFTER INSERT ON artifact_objects

BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_update_new AFTER UPDATE ON artifact_objects
WHEN new.artifact_id IS NOT old.artifact_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_update_old BEFORE UPDATE ON artifact_objects
WHEN new.artifact_id IS NOT old.artifact_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER change_artifact_objects_delete BEFORE DELETE ON artifact_objects
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results')),'removed',json_object('kind','artifact','id',OLD.artifact_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_objects_insert AFTER INSERT ON artifact_objects
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_objects_update AFTER UPDATE ON artifact_objects
WHEN NEW.owner_id IS NOT NULL AND (OLD.artifact_id IS NOT NEW.artifact_id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.call_id IS NOT NEW.call_id OR OLD.object_key IS NOT NEW.object_key OR OLD.mime IS NOT NEW.mime OR OLD.size IS NOT NEW.size OR OLD.checksum IS NOT NEW.checksum)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER done_attachment_artifact_objects_delete AFTER DELETE ON artifact_objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_attachment_artifact_objects_insert AFTER INSERT ON artifact_objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_attachment_artifact_objects_update AFTER UPDATE ON artifact_objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER project_feed_artifact_objects_delete BEFORE DELETE ON artifact_objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT OLD.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifact_objects_insert AFTER INSERT ON artifact_objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT NEW.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifact_objects_update AFTER UPDATE ON artifact_objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT OLD.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT NEW.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;
