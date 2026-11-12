-- 2b: artifact read filters and projections use the declared `role`; the
-- artifact `partial` metadata flag is gone (D4). These triggers previously
-- probed artifact metadata flags; each is recreated reading `role`, or for the
-- streaming churn guard reading the linked message's partial flag (messages
-- keep their partial/final flags; artifacts do not, so the artifact's own
-- metadata can no longer carry the guard).

-- Notification eligibility is exactly the answer role: tool traces, uploads,
-- published files, imports and snippets are never notified, and a native
-- answer only after its done checkpoint holds content.
DROP TRIGGER notify_result;
CREATE TRIGGER notify_result AFTER INSERT ON artifact_publications BEGIN
  INSERT OR IGNORE INTO push_deliveries(subscription_id,artifact_id,available_at)
  SELECT s.id,a.id,unixepoch()*1000 FROM artifacts a
  JOIN push_subscriptions s ON s.owner_id=a.owner_id
  WHERE a.id=new.artifact_id AND a.agent_id IS NOT NULL AND a.archived=0
    AND a.role='answer'
    AND (COALESCE(json_extract(a.metadata,'$.native'),0)=0 OR EXISTS(
      SELECT 1 FROM agent_checkpoints c WHERE c.run_id=a.run_id
        AND c.artifact_id=a.id AND c.stage='done' AND length(trim(a.content))>0));
END;

-- Search indexing defers until the artifact is no longer partial. The
-- artifact metadata no longer carries partial, so the guard follows the
-- linked message, which is written with the same flag in the same persist.
DROP TRIGGER artifact_search_update;
CREATE TRIGGER artifact_search_update AFTER UPDATE ON artifacts
WHEN NOT EXISTS(SELECT 1 FROM messages m
  WHERE m.id=json_extract(new.metadata,'$.messageId')
    AND json_extract(m.metadata,'$.partial') IS 1) BEGIN
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

-- The scope-change trigger existed only to reindex a move while content was
-- still partial; that state is now visible through the message guard above,
-- and filing changes only folder/kind, which the search_update trigger covers
-- once the artifact is no longer partial.
DROP TRIGGER artifact_search_scope_update;

-- Feed revisions: content/metadata writes stay invisible while the artifact is
-- streamed as partial (message guard), matching the old artifact-metadata
-- probe; membership and display changes always write a revision.
DROP TRIGGER artifact_feed_update;
CREATE TRIGGER artifact_feed_update AFTER UPDATE ON artifacts
WHEN ((new.content IS NOT old.content OR new.metadata IS NOT old.metadata OR new.updated_at IS NOT old.updated_at)
  AND NOT EXISTS(SELECT 1 FROM messages m
    WHERE m.id=json_extract(new.metadata,'$.messageId')
      AND json_extract(m.metadata,'$.partial') IS 1))
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
  -- Keep the first transition out of partial visible to delta readers so a
  -- previously published result can be removed. Explicit user metadata edits
  -- also remain visible to saved/files delta readers. Chunks do no work.
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
    VALUES('artifact',new.id,new.owner_id,new.rowid);
END;