-- Expand the provider CHECK for Muse Code. Preserve inbound references while
-- rebuilding with foreign keys ON, then restore the triggers the rebuild drops.
CREATE TEMP TABLE muse_agent_connections AS SELECT id,connection_id FROM agents WHERE connection_id IS NOT NULL;
CREATE TEMP TABLE muse_embedding_connections AS SELECT owner_id,embedding_connection FROM preferences WHERE embedding_connection IS NOT NULL;
UPDATE agents SET connection_id=NULL WHERE connection_id IS NOT NULL;
UPDATE preferences SET embedding_connection=NULL WHERE embedding_connection IS NOT NULL;
CREATE TABLE connections_muse(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','codex','pi','opencode','acp','gemini','muse')), label TEXT NOT NULL, secret TEXT NOT NULL, status TEXT NOT NULL, models TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
INSERT INTO connections_muse SELECT * FROM connections;
DROP TABLE connections;
ALTER TABLE connections_muse RENAME TO connections;
UPDATE agents SET connection_id=(SELECT connection_id FROM muse_agent_connections WHERE id=agents.id) WHERE id IN (SELECT id FROM muse_agent_connections);
UPDATE preferences SET embedding_connection=(SELECT embedding_connection FROM muse_embedding_connections WHERE owner_id=preferences.owner_id) WHERE owner_id IN (SELECT owner_id FROM muse_embedding_connections);
DROP TABLE muse_agent_connections;
DROP TABLE muse_embedding_connections;
-- Same definitions as migrations 099 and 108.
CREATE TRIGGER card_reader_connections_insert AFTER INSERT ON connections
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND json_extract(a.metadata,'$.connectionId')=new.id
    AND NOT COALESCE(json_type(a.metadata,'$.resolvedModel')='text' AND length(json_extract(a.metadata,'$.resolvedModel'))>0,0)
    AND json_type(a.metadata,'$.model')='text' AND length(json_extract(a.metadata,'$.model'))>0
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
CREATE TRIGGER card_reader_connections_delete BEFORE DELETE ON connections
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND json_extract(a.metadata,'$.connectionId')=old.id
    AND NOT COALESCE(json_type(a.metadata,'$.resolvedModel')='text' AND length(json_extract(a.metadata,'$.resolvedModel'))>0,0)
    AND json_type(a.metadata,'$.model')='text' AND length(json_extract(a.metadata,'$.model'))>0
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
CREATE TRIGGER card_reader_connections_update_old BEFORE UPDATE ON connections
WHEN new.id IS NOT old.id OR new.owner_id IS NOT old.owner_id OR new.provider IS NOT old.provider OR new.models IS NOT old.models
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND json_extract(a.metadata,'$.connectionId')=old.id
    AND NOT COALESCE(json_type(a.metadata,'$.resolvedModel')='text' AND length(json_extract(a.metadata,'$.resolvedModel'))>0,0)
    AND json_type(a.metadata,'$.model')='text' AND length(json_extract(a.metadata,'$.model'))>0
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
CREATE TRIGGER card_reader_connections_update_new AFTER UPDATE ON connections
WHEN new.id IS NOT old.id OR new.owner_id IS NOT old.owner_id OR new.provider IS NOT old.provider OR new.models IS NOT old.models
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND json_extract(a.metadata,'$.connectionId')=new.id
    AND NOT COALESCE(json_type(a.metadata,'$.resolvedModel')='text' AND length(json_extract(a.metadata,'$.resolvedModel'))>0,0)
    AND json_type(a.metadata,'$.model')='text' AND length(json_extract(a.metadata,'$.model'))>0
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
CREATE TRIGGER change_connections_insert AFTER INSERT ON connections
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'connection',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_connections_update AFTER UPDATE ON connections
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR OLD.label IS NOT NEW.label OR OLD.secret IS NOT NEW.secret OR OLD.status IS NOT NEW.status OR OLD.models IS NOT NEW.models OR OLD.metadata IS NOT NEW.metadata OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'connection',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_connections_delete BEFORE DELETE ON connections
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results')),'removed',json_object('kind','connection','id',OLD.id)),unixepoch('subsec')*1000;
END;
INSERT INTO schema_version VALUES(115,unixepoch()*1000);
