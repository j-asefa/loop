-- Keep artifacts and their versions live for viewing/editing, but defer the
-- derived search indexes until partial is cleared. Inserts still establish the
-- initial indexed snapshot; interrupted/paused drafts retain that snapshot.
DROP TRIGGER artifact_update;
CREATE TRIGGER artifact_update AFTER UPDATE ON artifacts
WHEN json_extract(new.metadata,'$.partial') IS NOT 1 BEGIN
  DELETE FROM artifact_fts WHERE artifact_id=old.id;
  INSERT INTO artifact_fts(artifact_id,owner_id,title,content)
    VALUES(new.id,new.owner_id,new.title,new.content);
END;

DROP TRIGGER artifact_search_update;
CREATE TRIGGER artifact_search_update AFTER UPDATE ON artifacts
WHEN json_extract(new.metadata,'$.partial') IS NOT 1 BEGIN
  -- Compare with the indexed snapshot, not old.content: on completion the last
  -- streamed chunk can already equal new.content while its embedding is stale.
  DELETE FROM embeddings WHERE document_id='artifact:'||new.id AND EXISTS(
    SELECT 1 FROM search_documents WHERE id='artifact:'||new.id
      AND (content<>new.content OR title<>new.title)
  );
  UPDATE search_documents SET title=new.title,content=new.content,
    folder_id=new.folder_id,kind=new.kind,updated_at=new.updated_at
    WHERE id='artifact:'||new.id;
END;

DROP TRIGGER artifact_feed_update;
CREATE TRIGGER artifact_feed_update AFTER UPDATE ON artifacts
WHEN json_extract(new.metadata,'$.partial') IS NOT 1
  OR json_extract(old.metadata,'$.partial') IS NOT 1 BEGIN
  -- Keep the first transition into partial visible to delta readers so a
  -- previously published result can be removed. Subsequent chunks do no work.
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES('artifact',new.id,new.owner_id,new.rowid);
END;
INSERT INTO schema_version VALUES(79,unixepoch()*1000);
