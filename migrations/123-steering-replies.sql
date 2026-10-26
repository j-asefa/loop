-- Published replies have identities and user state independent of run status.
CREATE TABLE steering_replies (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  steering_id TEXT NOT NULL REFERENCES run_steering(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX steering_replies_owner ON steering_replies(owner_id,archived_at,created_at DESC,message_id DESC);
CREATE INDEX steering_replies_question ON steering_replies(steering_id);

CREATE TRIGGER steering_replies_insert AFTER INSERT ON steering_replies BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  VALUES(NEW.owner_id,NULL,'collection','feed','invalidate',json_object('scope',json_object('kind','collection','id','feed')),unixepoch('subsec')*1000);
END;
CREATE TRIGGER steering_replies_update AFTER UPDATE OF read_at,archived_at ON steering_replies
WHEN OLD.read_at IS NOT NEW.read_at OR OLD.archived_at IS NOT NEW.archived_at BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  VALUES(NEW.owner_id,NULL,'collection','feed','invalidate',json_object('scope',json_object('kind','collection','id','feed')),unixepoch('subsec')*1000);
END;
CREATE TRIGGER steering_replies_delete AFTER DELETE ON steering_replies BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  VALUES(OLD.owner_id,NULL,'collection','feed','invalidate',json_object('scope',json_object('kind','collection','id','feed')),unixepoch('subsec')*1000);
END;
