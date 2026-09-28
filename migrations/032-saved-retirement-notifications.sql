ALTER TABLE agents ADD COLUMN retired_at INTEGER;

-- A bookmark has its own ordering: saving an older result brings it to the
-- top, without changing the publication order of the regular feed.
CREATE TABLE artifact_bookmarks(sequence INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE);
INSERT INTO artifact_bookmarks(artifact_id) SELECT id FROM artifacts WHERE pinned=1 ORDER BY updated_at,rowid;
CREATE TRIGGER artifact_bookmark_insert AFTER INSERT ON artifacts WHEN new.pinned=1 BEGIN
  INSERT OR IGNORE INTO artifact_bookmarks(artifact_id) VALUES(new.id);
END;
CREATE TRIGGER artifact_bookmark_update AFTER UPDATE OF pinned ON artifacts WHEN new.pinned<>old.pinned BEGIN
  DELETE FROM artifact_bookmarks WHERE artifact_id=new.id;
  INSERT INTO artifact_bookmarks(artifact_id) SELECT new.id WHERE new.pinned=1;
END;

CREATE TABLE push_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL);
CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, subscription TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(owner_id);
CREATE TABLE push_deliveries(subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY(subscription_id,artifact_id));
CREATE INDEX push_deliveries_pending ON push_deliveries(available_at) WHERE delivered_at IS NULL;
-- Publications are written transactionally when a result is complete. Existing
-- history is never replayed when a phone first subscribes.
CREATE TRIGGER notify_result AFTER INSERT ON artifact_publications BEGIN
  INSERT OR IGNORE INTO push_deliveries(subscription_id,artifact_id,available_at)
  SELECT s.id,a.id,unixepoch()*1000 FROM artifacts a
  JOIN push_subscriptions s ON s.owner_id=a.owner_id
  WHERE a.id=new.artifact_id AND a.agent_id IS NOT NULL AND a.archived=0
    AND json_extract(a.metadata,'$.tool') IS NULL
    AND COALESCE(json_extract(a.metadata,'$.native'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.partial'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.upload'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.uploaded'),0)=0
    AND COALESCE(json_extract(a.metadata,'$.origin'),'')<>'import'
    AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=a.run_id AND c.artifact_id<>a.id);
END;
INSERT INTO schema_version VALUES(32,unixepoch()*1000);
