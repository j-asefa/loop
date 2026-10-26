-- Feed reads now use the transactionally maintained card projection. Keep
-- legacy columns for upgrade compatibility, but never maintain or read them.
-- The permanent raw-history oracle lives in test/helpers/legacy-feed.ts.

DROP TRIGGER feed_state_approval_delete;

DROP TRIGGER feed_state_approval_insert;

DROP TRIGGER feed_state_approval_update;

DROP TRIGGER feed_state_conversation_insert;

DROP TRIGGER feed_state_conversation_update;

DROP TRIGGER feed_state_delegation_delete;

DROP TRIGGER feed_state_delegation_insert;

DROP TRIGGER feed_state_message_delete;

DROP TRIGGER feed_state_message_insert;

DROP TRIGGER feed_state_message_update;

DROP TRIGGER feed_state_run_delete;

DROP TRIGGER feed_state_run_insert;

DROP TRIGGER feed_state_run_update;

DROP TRIGGER feed_state_workflow_step_delete;

DROP TRIGGER feed_state_workflow_step_insert;

DROP TRIGGER feed_state_workflow_step_update;

DROP INDEX conversations_feed_activity;

DROP INDEX conversations_feed_done;

DROP INDEX done_card_expiry;

CREATE INDEX feed_cards_expiry ON feed_cards(owner_id,approval_until,conversation_id) WHERE kind='thread';

DROP TRIGGER change_conversations_update;

CREATE TRIGGER change_conversations_update AFTER UPDATE ON conversations
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_backend IS NOT NEW.execution_backend OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id OR OLD.feed_hidden IS NOT NEW.feed_hidden)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id',CASE WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_backend IS NOT NEW.execution_backend OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id THEN 'metadata' ELSE 'feed' END),CASE WHEN NEW.id IS NOT NULL THEN json_object('kind','conversation','id',NEW.id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

DROP VIEW done_card_candidates;

CREATE VIEW done_card_candidates AS
SELECT r.owner_id,r.conversation_id,'d:run:'||r.id key,
  CASE WHEN json_type(r.payload,'$.folderId') IS NOT NULL THEN json_extract(r.payload,'$.folderId') ELSE c.project_id END folder_id
FROM runs r LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
WHERE r.state='completed' AND EXISTS(SELECT 1 FROM messages INDEXED BY messages_feed_answers
  WHERE owner_id=r.owner_id AND conversation_id=r.conversation_id AND run_id=r.id AND role='assistant' AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND length(trim(content,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0)
UNION SELECT m.owner_id,m.conversation_id,'d:message:'||m.id,c.project_id
FROM messages m INDEXED BY messages_feed_answers LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
WHERE m.run_id IS NULL AND m.role='assistant' AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND length(trim(content,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0
UNION SELECT owner_id,conversation_id,'d:'||COALESCE(NULLIF(card_key,''),'idle:'||conversation_id),folder_id FROM feed_cards WHERE kind IN ('result','idle');

DROP TRIGGER done_conversation_context;

CREATE TRIGGER done_conversation_context AFTER UPDATE ON conversations WHEN new.title IS NOT old.title OR new.project_id IS NOT old.project_id OR new.team_id IS NOT old.team_id OR new.agent_id IS NOT old.agent_id OR new.execution_connection_id IS NOT old.execution_connection_id OR new.origin IS NOT old.origin OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id=new.id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

DROP TRIGGER done_conversation_delete;

CREATE TRIGGER done_conversation_delete AFTER DELETE ON conversations BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

DROP TRIGGER done_conversation_idle;

CREATE TRIGGER done_feed_cards_insert AFTER INSERT ON feed_cards
WHEN NEW.kind IN ('result','idle') BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) VALUES('done','d:'||COALESCE(NULLIF(NEW.card_key,''),'idle:'||NEW.conversation_id),NEW.owner_id,0) ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_feed_cards_update AFTER UPDATE ON feed_cards
WHEN NEW.kind IN ('result','idle') BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) VALUES('done','d:'||COALESCE(NULLIF(OLD.card_key,''),'idle:'||OLD.conversation_id),OLD.owner_id,0) ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) VALUES('done','d:'||COALESCE(NULLIF(NEW.card_key,''),'idle:'||NEW.conversation_id),NEW.owner_id,0) ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_feed_cards_delete AFTER DELETE ON feed_cards
WHEN OLD.kind IN ('result','idle') BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) VALUES('done','d:'||COALESCE(NULLIF(OLD.card_key,''),'idle:'||OLD.conversation_id),OLD.owner_id,0) ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

DROP TRIGGER project_feed_queue_insert;

CREATE TRIGGER project_feed_queue_insert AFTER INSERT ON runs WHEN NEW.state IN ('queued','running','pausing','paused','awaiting_approval') BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=NEW.owner_id AND r.agent_id=NEW.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_queue_delete;

CREATE TRIGGER project_feed_queue_delete BEFORE DELETE ON runs WHEN OLD.state IN ('queued','running','pausing','paused','awaiting_approval') BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=OLD.owner_id AND r.agent_id=OLD.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_queue_update;

CREATE TRIGGER project_feed_queue_update AFTER UPDATE ON runs WHEN (OLD.state IN ('queued','running','pausing','paused','awaiting_approval') OR NEW.state IN ('queued','running','pausing','paused','awaiting_approval')) AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.state IS NOT NEW.state OR OLD.queue_rank IS NOT NEW.queue_rank OR OLD.created_at IS NOT NEW.created_at OR json_extract(OLD.payload,'$.connectionId') IS NOT json_extract(NEW.payload,'$.connectionId')) BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=OLD.owner_id AND r.agent_id=OLD.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=NEW.owner_id AND r.agent_id=NEW.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_connections_insert;

CREATE TRIGGER project_feed_connections_insert AFTER INSERT ON connections BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT r.owner_id,r.conversation_id,'' FROM runs r
WHERE r.owner_id=NEW.owner_id AND r.state='queued' AND r.conversation_id IS NOT NULL
  AND r.agent_id IN (SELECT q.agent_id FROM runs q WHERE q.owner_id=NEW.owner_id AND q.state='queued'
    AND json_extract(q.payload,'$.connectionId')=NEW.id)
ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_connections_update;

CREATE TRIGGER project_feed_connections_update AFTER UPDATE ON connections WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR (json_extract(OLD.metadata,'$.loopHarness') IS NOT NULL) IS NOT (json_extract(NEW.metadata,'$.loopHarness') IS NOT NULL) BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT r.owner_id,r.conversation_id,'' FROM runs r
WHERE r.owner_id=OLD.owner_id AND r.state='queued' AND r.conversation_id IS NOT NULL
  AND r.agent_id IN (SELECT q.agent_id FROM runs q WHERE q.owner_id=OLD.owner_id AND q.state='queued'
    AND json_extract(q.payload,'$.connectionId')=OLD.id)
ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT r.owner_id,r.conversation_id,'' FROM runs r
WHERE r.owner_id=NEW.owner_id AND r.state='queued' AND r.conversation_id IS NOT NULL
  AND r.agent_id IN (SELECT q.agent_id FROM runs q WHERE q.owner_id=NEW.owner_id AND q.state='queued'
    AND json_extract(q.payload,'$.connectionId')=NEW.id)
ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_connections_delete;

CREATE TRIGGER project_feed_connections_delete BEFORE DELETE ON connections BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT r.owner_id,r.conversation_id,'' FROM runs r
WHERE r.owner_id=OLD.owner_id AND r.state='queued' AND r.conversation_id IS NOT NULL
  AND r.agent_id IN (SELECT q.agent_id FROM runs q WHERE q.owner_id=OLD.owner_id AND q.state='queued'
    AND json_extract(q.payload,'$.connectionId')=OLD.id)
ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_folders_insert;

DROP TRIGGER project_feed_folders_update;

DROP TRIGGER project_feed_folders_delete;

CREATE TRIGGER project_feed_folders_insert AFTER INSERT ON folders BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT owner_id,conversation_id,'*' FROM (
 SELECT p.owner_id,p.conversation_id FROM feed_cards p WHERE p.owner_id=NEW.owner_id
   AND (p.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT NEW.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=NEW.owner_id) SELECT id FROM subtree) OR json_extract(p.payload,'$.row.project_id')=NEW.id)
 UNION SELECT c.owner_id,c.id FROM conversations c WHERE c.owner_id=NEW.owner_id AND c.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT NEW.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=NEW.owner_id) SELECT id FROM subtree)
 UNION SELECT r.owner_id,r.conversation_id FROM runs r WHERE r.owner_id=NEW.owner_id AND r.conversation_id IS NOT NULL
   AND json_extract(r.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT NEW.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=NEW.owner_id) SELECT id FROM subtree)
) WHERE conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_folders_update_leaving BEFORE UPDATE ON folders WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.name IS NOT NEW.name OR OLD.kind IS NOT NEW.kind BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT owner_id,conversation_id,'*' FROM (
 SELECT p.owner_id,p.conversation_id FROM feed_cards p WHERE p.owner_id=OLD.owner_id
   AND (p.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=OLD.owner_id) SELECT id FROM subtree) OR json_extract(p.payload,'$.row.project_id')=OLD.id)
 UNION SELECT c.owner_id,c.id FROM conversations c WHERE c.owner_id=OLD.owner_id AND c.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=OLD.owner_id) SELECT id FROM subtree)
 UNION SELECT r.owner_id,r.conversation_id FROM runs r WHERE r.owner_id=OLD.owner_id AND r.conversation_id IS NOT NULL
   AND json_extract(r.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=OLD.owner_id) SELECT id FROM subtree)
) WHERE conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_folders_update_entering AFTER UPDATE ON folders WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.name IS NOT NEW.name OR OLD.kind IS NOT NEW.kind BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT owner_id,conversation_id,'*' FROM (
 SELECT p.owner_id,p.conversation_id FROM feed_cards p WHERE p.owner_id=NEW.owner_id
   AND (p.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT NEW.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=NEW.owner_id) SELECT id FROM subtree) OR json_extract(p.payload,'$.row.project_id')=NEW.id)
 UNION SELECT c.owner_id,c.id FROM conversations c WHERE c.owner_id=NEW.owner_id AND c.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT NEW.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=NEW.owner_id) SELECT id FROM subtree)
 UNION SELECT r.owner_id,r.conversation_id FROM runs r WHERE r.owner_id=NEW.owner_id AND r.conversation_id IS NOT NULL
   AND json_extract(r.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT NEW.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=NEW.owner_id) SELECT id FROM subtree)
) WHERE conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_folders_delete BEFORE DELETE ON folders BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT owner_id,conversation_id,'*' FROM (
 SELECT p.owner_id,p.conversation_id FROM feed_cards p WHERE p.owner_id=OLD.owner_id
   AND (p.folder_id IN (WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=OLD.owner_id) SELECT id FROM subtree) OR json_extract(p.payload,'$.row.project_id')=OLD.id)
 UNION SELECT c.owner_id,c.id FROM conversations c WHERE c.owner_id=OLD.owner_id AND c.project_id IN (WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=OLD.owner_id) SELECT id FROM subtree)
 UNION SELECT r.owner_id,r.conversation_id FROM runs r WHERE r.owner_id=OLD.owner_id AND r.conversation_id IS NOT NULL
   AND json_extract(r.payload,'$.folderId') IN (WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=OLD.owner_id) SELECT id FROM subtree)
) WHERE conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

DROP TRIGGER project_feed_workspace_projects_update;

CREATE TRIGGER project_feed_workspace_projects_update AFTER UPDATE ON workspace_projects WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.project_id IS NOT NEW.project_id BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT owner_id,id,'*' FROM conversations WHERE owner_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;


-- Result/idle projection changes now own Done identities. Retiring these raw
-- source revisions avoids publishing duplicate or invisible result candidates
-- for each streamed message and run timestamp update.
DROP TRIGGER done_messages_insert;
DROP TRIGGER done_messages_update;
DROP TRIGGER done_messages_delete;
DROP TRIGGER done_runs_insert;
DROP TRIGGER done_runs_update;
DROP TRIGGER done_runs_delete;

-- Thread-only indexes must not index every historical result. Membership
-- indexes contain only their matching rows, so streaming Working updates do
-- not rewrite Queued/Later/Outcomes/Needs indexes as well.
DROP INDEX feed_cards_order;
CREATE INDEX feed_cards_order ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread';
DROP INDEX feed_cards_folder;
CREATE INDEX feed_cards_folder ON feed_cards(owner_id,folder_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND folder_id IS NOT NULL;
DROP INDEX feed_cards_agent;
CREATE INDEX feed_cards_agent ON feed_cards(owner_id,agent_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND agent_id IS NOT NULL;
DROP INDEX feed_cards_team;
CREATE INDEX feed_cards_team ON feed_cards(owner_id,team_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND team_id IS NOT NULL;
DROP INDEX feed_cards_legacy;
CREATE INDEX feed_cards_legacy ON feed_cards(owner_id,legacy_sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread';
DROP INDEX feed_cards_working;
CREATE INDEX feed_cards_working ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND working=1;
DROP INDEX feed_cards_queued;
CREATE INDEX feed_cards_queued ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND queued=1;
DROP INDEX feed_cards_later;
CREATE INDEX feed_cards_later ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND snoozed=1;
DROP INDEX feed_cards_completed;
CREATE INDEX feed_cards_completed ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND completed=1;
DROP INDEX feed_cards_needs;
CREATE INDEX feed_cards_needs ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind='thread' AND (needs_run=1 OR approval_until IS NOT NULL);
DROP INDEX feed_cards_expiry;
CREATE INDEX feed_cards_expiry ON feed_cards(owner_id,approval_until,conversation_id) WHERE kind='thread' AND approval_until IS NOT NULL;
DROP INDEX feed_cards_summary;
CREATE INDEX feed_cards_summary ON feed_cards(owner_id,folder_id,agent_id,team_id,needs_run,approval_until,working,queued) WHERE kind='thread';

-- Unassigned folders use feed_cards_order. Agent/team filters accept concrete
-- identities, so indexing their null values only adds streamed-write traffic.
