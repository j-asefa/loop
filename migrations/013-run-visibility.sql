-- Run state is part of every response and prompt, including empty failed turns.
-- Invalidate loaded feed cards when a run stops without another output chunk.
CREATE TRIGGER run_feed_update AFTER UPDATE OF state,error ON runs
WHEN old.state IS NOT new.state OR old.error IS NOT new.error BEGIN
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
    SELECT 'artifact',id,owner_id,rowid FROM artifacts WHERE run_id=new.id;
  INSERT OR REPLACE INTO feed_revisions(entity,object_id,owner_id,cursor)
    SELECT 'prompt',id,owner_id,rowid FROM messages WHERE run_id=new.id AND role='user';
END;
INSERT INTO schema_version VALUES(13,unixepoch()*1000);
