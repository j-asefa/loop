ALTER TABLE native_permissions ADD COLUMN answers TEXT;
-- Restore intrinsic eligibility independently of mutable scope policies.
UPDATE memory_sources SET eligible = CASE WHEN tombstone=1 THEN 0
 WHEN kind != 'message' THEN 1
 ELSE EXISTS(SELECT 1 FROM messages m LEFT JOIN runs r ON r.id=m.run_id
 WHERE m.id=memory_sources.message_id AND m.owner_id=memory_sources.owner_id
 AND NOT COALESCE(json_extract(m.metadata,'$.partial'),0)
 AND NOT COALESCE(json_extract(m.metadata,'$.superseded'),0)
 AND (m.role='user' OR r.state IS NULL OR r.state='completed')) END,
 revision=revision+1;
INSERT INTO memory_outbox(source_id,revision,action)
 SELECT id,revision,'delete' FROM memory_sources WHERE true
 ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,action='delete',attempts=0,next_attempt=0;
INSERT INTO schema_version VALUES(29,unixepoch()*1000);
