-- Keep an unread decision after its read marker is deleted. A delayed read
-- from an older card snapshot must not erase that newer decision.
CREATE TABLE done_card_unread_versions(
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  card_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY(owner_id,conversation_id,card_key)
) WITHOUT ROWID;

-- Even marking an already-unread result unread advances its decision version.
-- Publish that version through Cards changes without changing unread counts.
CREATE TRIGGER done_unread_version_insert AFTER INSERT ON done_card_unread_versions BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) VALUES('done','d:'||NEW.card_key,NEW.owner_id,0) ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_unread_version_update AFTER UPDATE ON done_card_unread_versions BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) VALUES('done','d:'||NEW.card_key,NEW.owner_id,0) ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
