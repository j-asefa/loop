-- Native final answers belong in the feed; native tool artifacts still do not.
-- Only future publications notify. Restoring existing cards must not replay
-- historical phone notifications or modify the user's saved content.
DROP TRIGGER notify_result;
CREATE TRIGGER notify_result AFTER INSERT ON artifact_publications BEGIN
  INSERT OR IGNORE INTO push_deliveries(subscription_id,artifact_id,available_at)
  SELECT s.id,a.id,unixepoch()*1000 FROM artifacts a
  JOIN push_subscriptions s ON s.owner_id=a.owner_id
  WHERE a.id=new.artifact_id AND a.agent_id IS NOT NULL AND a.archived=0
    AND json_extract(a.metadata,'$.tool') IS NULL
    AND (COALESCE(json_extract(a.metadata,'$.native'),0)=0 OR EXISTS(
      SELECT 1 FROM agent_checkpoints c WHERE c.run_id=a.run_id
        AND c.artifact_id=a.id AND c.stage='done' AND length(trim(a.content))>0))
    AND COALESCE(json_extract(a.metadata,'$.partial'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.upload'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.uploaded'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.origin'),'')<>'import'
    AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=a.run_id AND c.artifact_id<>a.id);
END;

-- Give already-published native answers a new reconciliation watermark so a
-- connected app with an empty cached feed can discover its restored cards.
INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
SELECT 'artifact',a.id,a.owner_id,a.rowid FROM artifacts a
JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
JOIN agent_checkpoints c ON c.run_id=r.id AND c.artifact_id=a.id
WHERE r.state='completed' AND c.stage='done'
  AND json_extract(a.metadata,'$.native')=1
  AND json_extract(a.metadata,'$.tool') IS NULL
  AND COALESCE(json_extract(a.metadata,'$.partial'),0)=0
  AND length(trim(a.content))>0;
INSERT INTO schema_version VALUES(33,unixepoch()*1000);
