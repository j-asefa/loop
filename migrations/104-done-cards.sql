CREATE TABLE done_card_revisions(
  revision INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL,
  object_id TEXT NOT NULL, owner_id TEXT NOT NULL, cursor INTEGER NOT NULL,
  UNIQUE(owner_id,entity,object_id)
);
CREATE INDEX done_watch_expiry ON pr_watches(owner_id,state,updated_at,conversation_id);
CREATE INDEX done_card_expiry ON conversations(owner_id,feed_approval_until,id);
CREATE INDEX done_card_revisions_owner ON done_card_revisions(owner_id,revision);

-- Done identities have their own invalidations. Existing token grants are unchanged.
-- The projection includes run answers, imported messages and legacy idle cards.

-- Only identities that can represent a Done row fan out for context updates.
-- Direct run/message triggers retain removals when a record leaves this view.
CREATE VIEW done_card_candidates AS
SELECT r.owner_id,r.conversation_id,'d:run:'||r.id key,
  CASE WHEN json_type(r.payload,'$.folderId') IS NOT NULL THEN json_extract(r.payload,'$.folderId') ELSE c.project_id END folder_id
FROM runs r LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
WHERE r.state='completed' AND EXISTS(SELECT 1 FROM messages INDEXED BY messages_feed_answers
  WHERE owner_id=r.owner_id AND conversation_id=r.conversation_id AND run_id=r.id AND role='assistant' AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND length(trim(content,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0)
UNION SELECT m.owner_id,m.conversation_id,'d:message:'||m.id,c.project_id
FROM messages m INDEXED BY messages_feed_answers LEFT JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
WHERE m.run_id IS NULL AND m.role='assistant' AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND length(trim(content,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0
UNION SELECT owner_id,id,'d:'||COALESCE('run:'||feed_done_run_id,'message:'||feed_last_message_id,'run:'||feed_run_id,'idle:'||id),feed_folder_id FROM conversations;

CREATE TRIGGER done_runs_insert AFTER INSERT ON runs BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_runs_update AFTER UPDATE ON runs WHEN new.state IS NOT old.state OR new.error IS NOT old.error OR new.input IS NOT old.input OR new.payload IS NOT old.payload OR new.agent_id IS NOT old.agent_id OR new.conversation_id IS NOT old.conversation_id OR new.owner_id IS NOT old.owner_id OR new.created_at IS NOT old.created_at OR new.updated_at IS NOT old.updated_at BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_runs_delete AFTER DELETE ON runs BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_messages_insert AFTER INSERT ON messages BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||new.id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_messages_update AFTER UPDATE ON messages
WHEN new.owner_id IS NOT old.owner_id OR new.conversation_id IS NOT old.conversation_id
  OR new.run_id IS NOT old.run_id OR new.role IS NOT old.role OR new.created_at IS NOT old.created_at
  OR json_extract(new.metadata,'$.progress') IS NOT json_extract(old.metadata,'$.progress')
  OR json_extract(new.metadata,'$.partial') IS NOT json_extract(old.metadata,'$.partial')
  OR ((new.content IS NOT old.content OR new.metadata IS NOT old.metadata)
    AND (json_extract(new.metadata,'$.partial') IS NOT 1 OR json_extract(old.metadata,'$.partial') IS NOT 1
      OR new.run_id IS NULL OR old.run_id IS NULL
      OR EXISTS(SELECT 1 FROM runs WHERE id IN (old.run_id,new.run_id) AND state='completed')))
BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||old.id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||new.id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_messages_delete AFTER DELETE ON messages BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||old.id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_conversation_context AFTER UPDATE ON conversations WHEN new.title IS NOT old.title OR new.project_id IS NOT old.project_id OR new.team_id IS NOT old.team_id OR new.agent_id IS NOT old.agent_id OR new.execution_connection_id IS NOT old.execution_connection_id OR new.origin IS NOT old.origin OR new.owner_id IS NOT old.owner_id OR new.feed_visible IS NOT old.feed_visible BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT 'd:'||COALESCE('run:'||old.feed_done_run_id,'message:'||old.feed_last_message_id,'run:'||old.feed_run_id,'idle:'||old.id) key,old.owner_id owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id=new.id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT 'd:'||COALESCE('run:'||new.feed_done_run_id,'message:'||new.feed_last_message_id,'run:'||new.feed_run_id,'idle:'||new.id) key,new.owner_id owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_conversation_delete AFTER DELETE ON conversations BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT 'd:'||COALESCE('run:'||old.feed_done_run_id,'message:'||old.feed_last_message_id,'run:'||old.feed_run_id,'idle:'||old.id) key,old.owner_id owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_conversation_idle AFTER UPDATE ON conversations WHEN new.feed_done_run_id IS NOT old.feed_done_run_id OR new.feed_last_message_id IS NOT old.feed_last_message_id OR new.feed_run_id IS NOT old.feed_run_id OR new.feed_last_activity_at IS NOT old.feed_last_activity_at OR new.feed_run_raw_state IS NOT old.feed_run_raw_state OR new.feed_queued IS NOT old.feed_queued OR new.feed_run_state IS NOT old.feed_run_state OR new.feed_approval_until IS NOT old.feed_approval_until OR new.feed_run_dismissed_at IS NOT old.feed_run_dismissed_at OR new.feed_folder_id IS NOT old.feed_folder_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:'||COALESCE('run:'||old.feed_done_run_id,'message:'||old.feed_last_message_id,'run:'||old.feed_run_id,'idle:'||old.id) id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:'||COALESCE('run:'||new.feed_done_run_id,'message:'||new.feed_last_message_id,'run:'||new.feed_run_id,'idle:'||new.id) id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_done_card_dismissals_insert AFTER INSERT ON done_card_dismissals BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:'||new.card_key id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_done_card_dismissals_update AFTER UPDATE ON done_card_dismissals BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:'||old.card_key id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:'||new.card_key id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_done_card_dismissals_delete AFTER DELETE ON done_card_dismissals BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:'||old.card_key id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;




CREATE TRIGGER done_later_items_insert AFTER INSERT ON later_items BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND new.kind='conversation' AND conversation_id=new.target_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_later_items_update AFTER UPDATE ON later_items WHEN new.kind IS NOT old.kind OR new.target_id IS NOT old.target_id OR new.due_at IS NOT old.due_at OR new.condition IS NOT old.condition OR new.surfaced_at IS NOT old.surfaced_at OR new.done_at IS NOT old.done_at OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND old.kind='conversation' AND conversation_id=old.target_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND new.kind='conversation' AND conversation_id=new.target_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_later_items_delete AFTER DELETE ON later_items BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND old.kind='conversation' AND conversation_id=old.target_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_pr_watches_insert AFTER INSERT ON pr_watches BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id=new.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_pr_watches_update AFTER UPDATE ON pr_watches WHEN new.conversation_id IS NOT old.conversation_id OR new.owner_id IS NOT old.owner_id OR new.repo_owner IS NOT old.repo_owner OR new.repo_name IS NOT old.repo_name OR new.number IS NOT old.number OR new.state IS NOT old.state OR new.ended_reason IS NOT old.ended_reason OR new.error IS NOT old.error OR new.head_sha IS NOT old.head_sha OR new.ci_sha IS NOT old.ci_sha OR new.ci_conclusion IS NOT old.ci_conclusion OR new.ci_pending IS NOT old.ci_pending OR new.read_at IS NOT old.read_at OR new.seen_ci_sha IS NOT old.seen_ci_sha OR new.seen_ci_conclusion IS NOT old.seen_ci_conclusion OR new.created_at IS NOT old.created_at OR (new.state='stopped' AND new.updated_at IS NOT old.updated_at) BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id=new.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_pr_watches_delete AFTER DELETE ON pr_watches BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id=old.conversation_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_run_checkouts_insert AFTER INSERT ON run_checkouts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_run_checkouts_update AFTER UPDATE ON run_checkouts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_run_checkouts_delete AFTER DELETE ON run_checkouts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_run_verifications_insert AFTER INSERT ON run_verifications BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_run_verifications_update AFTER UPDATE ON run_verifications BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||new.run_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_run_verifications_delete AFTER DELETE ON run_verifications BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||old.run_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_message_bookmarks_insert AFTER INSERT ON message_bookmarks BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||new.message_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||run_id id,owner_id owner FROM messages WHERE id=new.message_id AND owner_id=new.owner_id) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_message_bookmarks_update AFTER UPDATE ON message_bookmarks BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||old.message_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||run_id id,owner_id owner FROM messages WHERE id=old.message_id AND owner_id=old.owner_id) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||new.message_id id,new.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||run_id id,owner_id owner FROM messages WHERE id=new.message_id AND owner_id=new.owner_id) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_message_bookmarks_delete AFTER DELETE ON message_bookmarks BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||old.message_id id,old.owner_id owner) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:run:'||run_id id,owner_id owner FROM messages WHERE id=old.message_id AND owner_id=old.owner_id) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_agents_insert AFTER INSERT ON agents BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=new.owner_id AND agent_id=new.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_agents_update AFTER UPDATE ON agents WHEN new.name IS NOT old.name OR new.provider IS NOT old.provider OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=old.owner_id AND agent_id=old.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=new.owner_id AND agent_id=new.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_agents_delete AFTER DELETE ON agents BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=old.owner_id AND agent_id=old.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_folders_insert AFTER INSERT ON folders BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=new.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=new.owner_id AND project_id=new.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=new.owner_id AND w.project_id=new.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_folders_update AFTER UPDATE ON folders WHEN new.name IS NOT old.name OR new.kind IS NOT old.kind OR new.parent_id IS NOT old.parent_id OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=old.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=old.owner_id AND project_id=old.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=old.owner_id AND w.project_id=old.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT new.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=new.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=new.owner_id AND project_id=new.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=new.owner_id AND w.project_id=new.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_folders_delete AFTER DELETE ON folders BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND (folder_id IN (WITH RECURSIVE subtree(id) AS (
      SELECT old.id UNION SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.owner_id=old.owner_id
    ) SELECT id FROM subtree) OR folder_id IN (SELECT folder_id FROM project_change_folders WHERE owner_id=old.owner_id AND project_id=old.id) OR (folder_id IS NULL AND EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=old.owner_id AND w.project_id=old.id)))) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_teams_insert AFTER INSERT ON teams BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=new.owner_id AND team_id=new.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_teams_update AFTER UPDATE ON teams WHEN new.hide_results_from_feed IS NOT old.hide_results_from_feed OR new.deleted_at IS NOT old.deleted_at OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=old.owner_id AND team_id=old.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=new.owner_id AND team_id=new.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_teams_delete AFTER DELETE ON teams BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id AND conversation_id IN (SELECT id FROM conversations WHERE owner_id=old.owner_id AND team_id=old.id)) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_workspace_projects_insert AFTER INSERT ON workspace_projects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_workspace_projects_update AFTER UPDATE ON workspace_projects WHEN new.project_id IS NOT old.project_id OR new.owner_id IS NOT old.owner_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=new.owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_workspace_projects_delete AFTER DELETE ON workspace_projects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',key,owner_id,0 FROM (SELECT key,owner_id FROM done_card_candidates WHERE owner_id=old.owner_id) WHERE key IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_artifacts_insert AFTER INSERT ON artifacts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||m.id id,m.owner_id owner FROM messages m WHERE m.owner_id=new.owner_id AND m.id=json_extract(new.metadata,'$.messageId') UNION SELECT 'd:run:'||m.run_id,m.owner_id FROM messages m WHERE m.owner_id=new.owner_id AND m.id=json_extract(new.metadata,'$.messageId')) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_artifacts_update AFTER UPDATE ON artifacts WHEN new.pinned IS NOT old.pinned OR new.archived IS NOT old.archived OR new.metadata IS NOT old.metadata OR new.owner_id IS NOT old.owner_id OR new.conversation_id IS NOT old.conversation_id BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||m.id id,m.owner_id owner FROM messages m WHERE m.owner_id=old.owner_id AND m.id=json_extract(old.metadata,'$.messageId') UNION SELECT 'd:run:'||m.run_id,m.owner_id FROM messages m WHERE m.owner_id=old.owner_id AND m.id=json_extract(old.metadata,'$.messageId')) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||m.id id,m.owner_id owner FROM messages m WHERE m.owner_id=new.owner_id AND m.id=json_extract(new.metadata,'$.messageId') UNION SELECT 'd:run:'||m.run_id,m.owner_id FROM messages m WHERE m.owner_id=new.owner_id AND m.id=json_extract(new.metadata,'$.messageId')) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER done_artifacts_delete AFTER DELETE ON artifacts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done',id,owner,0 FROM (SELECT 'd:message:'||m.id id,m.owner_id owner FROM messages m WHERE m.owner_id=old.owner_id AND m.id=json_extract(old.metadata,'$.messageId') UNION SELECT 'd:run:'||m.run_id,m.owner_id FROM messages m WHERE m.owner_id=old.owner_id AND m.id=json_extract(old.metadata,'$.messageId')) WHERE id IS NOT NULL AND owner IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;


CREATE TRIGGER done_attachment_artifacts_insert AFTER INSERT ON artifacts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_artifacts_update AFTER UPDATE ON artifacts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_artifacts_delete AFTER DELETE ON artifacts BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_objects_insert AFTER INSERT ON objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.objectId')=new.id) AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.objectId')=new.id) AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_objects_update AFTER UPDATE ON objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.objectId')=old.id) AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.objectId')=old.id) AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.objectId')=new.id) AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=new.owner_id AND json_extract(metadata,'$.objectId')=new.id) AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_objects_delete AFTER DELETE ON objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.objectId')=old.id) AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id IN (SELECT id FROM artifacts WHERE owner_id=old.owner_id AND json_extract(metadata,'$.objectId')=old.id) AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_artifact_objects_insert AFTER INSERT ON artifact_objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_artifact_objects_update AFTER UPDATE ON artifact_objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=new.owner_id AND refs.target_id=new.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER done_attachment_artifact_objects_delete AFTER DELETE ON artifact_objects BEGIN
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:message:'||m.id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:message:'||m.id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
INSERT INTO done_card_revisions(entity,object_id,owner_id,cursor) SELECT 'done','d:run:'||m.run_id,m.owner_id,0 FROM card_attachment_refs refs JOIN messages m ON m.id=refs.object_id AND m.owner_id=refs.owner_id WHERE refs.entity='message' AND refs.owner_id=old.owner_id AND refs.target_id=old.artifact_id AND 'd:run:'||m.run_id IS NOT NULL ON CONFLICT(owner_id,entity,object_id) DO UPDATE SET revision=excluded.revision;
END;
INSERT INTO schema_version VALUES(104,unixepoch()*1000);
