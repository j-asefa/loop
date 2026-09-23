-- Keep only the latest change for each feed object, including removal tombstones.
-- A monotonic revision avoids timestamp ties and lets clients reconcile a loaded
-- window without fetching its pages again.
CREATE TABLE feed_revisions(
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  object_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  UNIQUE(entity,object_id)
);
CREATE INDEX feed_revisions_owner ON feed_revisions(owner_id,entity,revision);
CREATE INDEX feed_revisions_watermark ON feed_revisions(owner_id,revision);
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',id,owner_id,rowid FROM artifacts;
INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'prompt',id,owner_id,rowid FROM messages WHERE role='user';
CREATE TRIGGER artifact_feed_insert AFTER INSERT ON artifacts BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('artifact',new.id,new.owner_id,new.rowid);
END;
CREATE TRIGGER artifact_feed_update AFTER UPDATE ON artifacts BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('artifact',new.id,new.owner_id,new.rowid);
END;
CREATE TRIGGER artifact_feed_delete AFTER DELETE ON artifacts BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('artifact',old.id,old.owner_id,old.rowid);
END;
CREATE TRIGGER prompt_feed_insert AFTER INSERT ON messages WHEN new.role='user' BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('prompt',new.id,new.owner_id,new.rowid);
END;
CREATE TRIGGER prompt_feed_update AFTER UPDATE ON messages WHEN new.role='user' OR old.role='user' BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('prompt',new.id,new.owner_id,new.rowid);
END;
CREATE TRIGGER prompt_feed_delete AFTER DELETE ON messages WHEN old.role='user' BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('prompt',old.id,old.owner_id,old.rowid);
END;
CREATE TRIGGER agent_feed_update AFTER UPDATE OF name,provider ON agents BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
    SELECT 'artifact',id,owner_id,rowid FROM artifacts WHERE agent_id=new.id;
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
    SELECT 'prompt',m.id,m.owner_id,m.rowid FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.agent_id=new.id AND m.role='user';
END;
INSERT INTO schema_version VALUES(9,unixepoch()*1000);
