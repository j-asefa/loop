-- Include delegated tasks and workflow steps in stored Feed state.
-- Replace the state writers and backfill existing conversations.
DROP TRIGGER feed_state_run_insert;
DROP TRIGGER feed_state_run_update;
DROP TRIGGER feed_state_run_delete;
DROP TRIGGER feed_state_message_insert;
DROP TRIGGER feed_state_message_update;
DROP TRIGGER feed_state_message_delete;
DROP TRIGGER feed_state_approval_insert;
DROP TRIGGER feed_state_approval_update;
DROP TRIGGER feed_state_approval_delete;
DROP TRIGGER feed_state_delegation_insert;
DROP TRIGGER feed_state_delegation_delete;
DROP TRIGGER feed_state_workflow_step_insert;
DROP TRIGGER feed_state_workflow_step_update;
DROP TRIGGER feed_state_workflow_step_delete;
DROP TRIGGER feed_state_conversation_insert;
DROP TRIGGER feed_state_conversation_update;

-- Backfill every existing conversation.
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE 1;
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE 1;

CREATE TRIGGER feed_state_run_insert AFTER INSERT ON runs BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=new.conversation_id;
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=new.conversation_id;
END;
CREATE TRIGGER feed_state_run_update AFTER UPDATE OF state,worker_id,updated_at,created_at,attention_dismissed_at,conversation_id,payload,owner_id ON runs BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id IN (new.conversation_id,old.conversation_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id IN (new.conversation_id,old.conversation_id);
END;
CREATE TRIGGER feed_state_run_delete AFTER DELETE ON runs BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=old.conversation_id;
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=old.conversation_id;
END;
CREATE TRIGGER feed_state_message_insert AFTER INSERT ON messages BEGIN
UPDATE conversations SET
  feed_last_activity_at=max(COALESCE(feed_last_activity_at,created_at),new.created_at),
  feed_last_message_id=CASE WHEN feed_last_message_id IS NULL
      OR new.created_at>=COALESCE((SELECT m.created_at FROM messages m WHERE m.id=conversations.feed_last_message_id),new.created_at)
    THEN new.id ELSE feed_last_message_id END,
  feed_visible=CASE WHEN feed_visible=1 THEN 1 ELSE ((EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)) AND (NOT EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id))) END
WHERE id=new.conversation_id AND owner_id=new.owner_id;
END;
CREATE TRIGGER feed_state_message_update AFTER UPDATE OF conversation_id,created_at,owner_id ON messages BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id IN (new.conversation_id,old.conversation_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id IN (new.conversation_id,old.conversation_id);
END;
CREATE TRIGGER feed_state_message_delete AFTER DELETE ON messages BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=old.conversation_id;
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=old.conversation_id;
END;
CREATE TRIGGER feed_state_approval_insert AFTER INSERT ON approvals BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=new.run_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=new.run_id);
END;
CREATE TRIGGER feed_state_approval_update AFTER UPDATE OF state,expires_at,run_id,owner_id ON approvals BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id IN ((SELECT conversation_id FROM runs WHERE id=new.run_id),(SELECT conversation_id FROM runs WHERE id=old.run_id));
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id IN ((SELECT conversation_id FROM runs WHERE id=new.run_id),(SELECT conversation_id FROM runs WHERE id=old.run_id));
END;
CREATE TRIGGER feed_state_approval_delete AFTER DELETE ON approvals BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=old.run_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=old.run_id);
END;
CREATE TRIGGER feed_state_delegation_insert AFTER INSERT ON delegations BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=new.child_run_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=new.child_run_id);
END;
CREATE TRIGGER feed_state_delegation_delete AFTER DELETE ON delegations BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=old.child_run_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=old.child_run_id);
END;
CREATE TRIGGER feed_state_workflow_step_insert AFTER INSERT ON workflow_steps BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=new.child_run_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=new.child_run_id);
END;
CREATE TRIGGER feed_state_workflow_step_update AFTER UPDATE OF child_run_id ON workflow_steps BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id IN ((SELECT conversation_id FROM runs WHERE id=new.child_run_id),(SELECT conversation_id FROM runs WHERE id=old.child_run_id));
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id IN ((SELECT conversation_id FROM runs WHERE id=new.child_run_id),(SELECT conversation_id FROM runs WHERE id=old.child_run_id));
END;
CREATE TRIGGER feed_state_workflow_step_delete AFTER DELETE ON workflow_steps BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=old.child_run_id);
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=(SELECT conversation_id FROM runs WHERE id=old.child_run_id);
END;
CREATE TRIGGER feed_state_conversation_insert AFTER INSERT ON conversations BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=new.id;
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=new.id;
END;
CREATE TRIGGER feed_state_conversation_update AFTER UPDATE OF project_id,created_at,owner_id ON conversations BEGIN
UPDATE conversations SET feed_run_id=COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_queued=(SELECT count(*) FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='queued'),
  feed_done_run_id=(SELECT r.id FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_done_at=(SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
  feed_last_activity_at=max(conversations.created_at,COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC LIMIT 1),0),COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.updated_at DESC LIMIT 1),0)),
  feed_last_message_id=(SELECT m.id FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
  feed_folder_id=COALESCE(conversations.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)),
  feed_visible=(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=conversations.owner_id AND m.conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=conversations.owner_id AND r.conversation_id=conversations.id)),
  feed_approval_until=(SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.owner_id=conversations.owner_id AND a.state='pending' AND +r.conversation_id=conversations.id)
WHERE id=new.id;
UPDATE conversations SET feed_run_raw_state=(SELECT cr.state FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_state=(SELECT CASE WHEN cr.state IN ('running','pausing') AND cr.worker_id IS NULL THEN 'waiting_children' ELSE cr.state END FROM runs cr WHERE cr.id=conversations.feed_run_id),
  feed_run_dismissed_at=(SELECT cr.attention_dismissed_at FROM runs cr WHERE cr.id=conversations.feed_run_id)
WHERE id=new.id;
END;

INSERT INTO schema_version VALUES(84,unixepoch()*1000);
