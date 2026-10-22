-- Refresh author provenance and tombstones skipped by older partial triggers.
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor)
SELECT 'done',key,owner_id,0 FROM (
  SELECT object_id key,owner_id FROM done_card_revisions
  UNION SELECT key,owner_id FROM done_card_candidates
) WHERE key IS NOT NULL AND owner_id IS NOT NULL
ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;

INSERT INTO schema_version(version,applied_at) VALUES(106,unixepoch()*1000);
