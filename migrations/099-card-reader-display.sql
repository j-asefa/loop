-- Additional typed reader display fields depend on file-link authorization.
CREATE INDEX card_artifact_raw_object_link ON artifacts(owner_id,json_extract(metadata,'$.rawObjectId'));
CREATE INDEX card_artifact_model_connection ON artifacts(owner_id,json_extract(metadata,'$.connectionId'));

-- Alias-only historical results use their own saved account's model catalog.
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

CREATE TRIGGER card_reader_objects_insert_new AFTER INSERT ON objects

BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id IN (SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.objectId')=new.id UNION SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.rawObjectId')=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_objects_delete_old BEFORE DELETE ON objects

BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id IN (SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.objectId')=old.id UNION SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.rawObjectId')=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_objects_update_old BEFORE UPDATE ON objects
WHEN new.id IS NOT old.id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id IN (SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.objectId')=old.id UNION SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.rawObjectId')=old.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_objects_update_new AFTER UPDATE ON objects
WHEN new.id IS NOT old.id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id IN (SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.objectId')=new.id UNION SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.rawObjectId')=new.id)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_insert_new AFTER INSERT ON artifact_objects

BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_delete_old BEFORE DELETE ON artifact_objects

BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_update_old BEFORE UPDATE ON artifact_objects
WHEN new.artifact_id IS NOT old.artifact_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=old.owner_id AND a.id=old.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_artifact_objects_update_new AFTER UPDATE ON artifact_objects
WHEN new.artifact_id IS NOT old.artifact_id OR new.owner_id IS NOT old.owner_id
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor)
  SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a WHERE a.owner_id=new.owner_id AND a.id=new.artifact_id
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;

CREATE TRIGGER card_reader_display AFTER UPDATE OF metadata ON artifacts
WHEN json_extract(new.metadata,'$.snippet') IS NOT json_extract(old.metadata,'$.snippet')
  OR json_extract(new.metadata,'$.arguments') IS NOT json_extract(old.metadata,'$.arguments')
  OR json_extract(new.metadata,'$.size') IS NOT json_extract(old.metadata,'$.size')
  OR json_extract(new.metadata,'$.text') IS NOT json_extract(old.metadata,'$.text')
  OR json_extract(new.metadata,'$.source') IS NOT json_extract(old.metadata,'$.source')
  OR json_extract(new.metadata,'$.connectionId') IS NOT json_extract(old.metadata,'$.connectionId')
  OR json_extract(new.metadata,'$.provider') IS NOT json_extract(old.metadata,'$.provider')
  OR json_extract(new.metadata,'$.appResource') IS NOT json_extract(old.metadata,'$.appResource')
  OR json_extract(new.metadata,'$.workflowId') IS NOT json_extract(old.metadata,'$.workflowId')
  OR json_extract(new.metadata,'$.objectId') IS NOT json_extract(old.metadata,'$.objectId')
  OR json_extract(new.metadata,'$.rawObjectId') IS NOT json_extract(old.metadata,'$.rawObjectId')
BEGIN
  INSERT INTO feed_revisions(entity,object_id,owner_id,cursor) VALUES('artifact',new.id,new.owner_id,new.rowid)
  ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor;
END;
-- Existing cursors describe the earlier projection. Require a fresh backfill
-- so unchanged historical rows acquire the new display fields and model labels.
UPDATE card_revision_domain SET epoch=lower(hex(randomblob(24))) WHERE singleton=1;
INSERT INTO schema_version VALUES(99,unixepoch()*1000);
