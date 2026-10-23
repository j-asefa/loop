-- Subjects carry projection identity without borrowing a run. Legacy writers
-- retain their explicit original-column INSERT shape and run foreign key.
CREATE TABLE events_next(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'run' CHECK(subject_kind IN
    ('run','conversation','message','artifact','approval','decision','later',
     'scheduled_send','mail_thread','connection','agent','folder','team','social','collection')),
  subject_id TEXT,
  CHECK((subject_kind='run' AND run_id IS NOT NULL AND (subject_id IS NULL OR subject_id=run_id))
    OR (subject_kind<>'run' AND subject_id IS NOT NULL))
);
INSERT INTO events_next SELECT * FROM events;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'events_next',seq FROM sqlite_sequence
WHERE name='events' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='events_next');
UPDATE sqlite_sequence SET seq=max(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0))
WHERE name='events_next';
DROP TABLE events;
ALTER TABLE events_next RENAME TO events;
CREATE INDEX event_cursor ON events(owner_id,id);
CREATE INDEX events_run ON events(run_id,id);
CREATE INDEX events_subject ON events(owner_id,subject_kind,subject_id,id);
CREATE TRIGGER events_run_subject AFTER INSERT ON events
WHEN NEW.subject_kind='run' AND NEW.subject_id IS NULL
BEGIN UPDATE events SET subject_id=NEW.run_id WHERE id=NEW.id; END;
CREATE TRIGGER events_run_subject_update AFTER UPDATE OF subject_kind,run_id,subject_id ON events
WHEN NEW.subject_kind='run' AND NEW.subject_id IS NULL
BEGIN UPDATE events SET subject_id=NEW.run_id WHERE id=NEW.id; END;

-- Existing cascades may already have removed an owner's highest event. The
-- migration starts each known owner in a fresh epoch at the global sequence;
-- its first reset reconciles the snapshot, and no old ID can be reused.
-- An owner with no events has an implicit zero watermark in this persisted
-- epoch. HTTP snapshots can read it without acquiring the writer lock. The
-- first event or socket initialization materializes the same owner identity.
CREATE TABLE change_log_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);
INSERT INTO change_log_identity VALUES(1,lower(hex(randomblob(16))));
CREATE TABLE change_watermark(
  owner_id TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL CHECK(last_event_id>=0),
  epoch TEXT NOT NULL
);
INSERT INTO change_watermark(owner_id,last_event_id,epoch)
SELECT owner_id,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0),lower(hex(randomblob(16)))
FROM (
 SELECT owner_id FROM events UNION SELECT owner_id FROM runs
 UNION SELECT owner_id FROM conversations UNION SELECT owner_id FROM agents
 UNION SELECT owner_id FROM connections UNION SELECT owner_id FROM folders
 UNION SELECT owner_id FROM artifacts UNION SELECT owner_id FROM teams
 UNION SELECT owner_id FROM later_items UNION SELECT owner_id FROM scheduled_sends
 UNION SELECT owner_id FROM agent_threads UNION SELECT owner_id FROM feed_subscriptions
 UNION SELECT owner_id FROM feed_preferences
);
CREATE TRIGGER events_watermark AFTER INSERT ON events BEGIN
 INSERT INTO change_watermark(owner_id,last_event_id,epoch)
 VALUES(NEW.owner_id,NEW.id,(SELECT epoch FROM change_log_identity WHERE singleton=1))
 ON CONFLICT(owner_id) DO UPDATE SET last_event_id=max(last_event_id,excluded.last_event_id);
END;


-- Projection producers are atomic with their source writes and the existing
-- Cards/Done compatibility triggers. Payloads contain identity only.

CREATE TRIGGER change_runs_insert AFTER INSERT ON runs
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NEW.id,'run',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','approvals'),json_object('kind','collection','id','decisions'),json_object('kind','collection','id','activities'),json_object('kind','collection','id','pulls'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_runs_update AFTER UPDATE ON runs
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.kind IS NOT NEW.kind OR OLD.input IS NOT NEW.input OR OLD.state IS NOT NEW.state OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.payload IS NOT NEW.payload OR OLD.result IS NOT NEW.result OR OLD.error IS NOT NEW.error OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.active_ms IS NOT NEW.active_ms OR OLD.active_since IS NOT NEW.active_since OR OLD.attention_dismissed_at IS NOT NEW.attention_dismissed_at OR OLD.queue_rank IS NOT NEW.queue_rank)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NEW.id,'run',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','approvals'),json_object('kind','collection','id','decisions'),json_object('kind','collection','id','activities'),json_object('kind','collection','id','pulls'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_runs_delete BEFORE DELETE ON runs
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','approvals'),json_object('kind','collection','id','decisions'),json_object('kind','collection','id','activities'),json_object('kind','collection','id','pulls'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','runs') END),'removed',json_object('kind','run','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_conversations_insert AFTER INSERT ON conversations
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id','metadata'),CASE WHEN NEW.id IS NOT NULL THEN json_object('kind','conversation','id',NEW.id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_conversations_update AFTER UPDATE ON conversations
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_backend IS NOT NEW.execution_backend OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id OR OLD.feed_hidden IS NOT NEW.feed_hidden OR OLD.feed_run_id IS NOT NEW.feed_run_id OR OLD.feed_run_raw_state IS NOT NEW.feed_run_raw_state OR OLD.feed_run_state IS NOT NEW.feed_run_state OR OLD.feed_run_dismissed_at IS NOT NEW.feed_run_dismissed_at OR OLD.feed_queued IS NOT NEW.feed_queued OR OLD.feed_done_run_id IS NOT NEW.feed_done_run_id OR OLD.feed_done_at IS NOT NEW.feed_done_at OR OLD.feed_last_activity_at IS NOT NEW.feed_last_activity_at OR OLD.feed_last_message_id IS NOT NEW.feed_last_message_id OR OLD.feed_folder_id IS NOT NEW.feed_folder_id OR OLD.feed_visible IS NOT NEW.feed_visible OR OLD.feed_approval_until IS NOT NEW.feed_approval_until)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id','metadata'),CASE WHEN NEW.id IS NOT NULL THEN json_object('kind','conversation','id',NEW.id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_conversations_delete BEFORE DELETE ON conversations
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id','metadata'),CASE WHEN OLD.id IS NOT NULL THEN json_object('kind','conversation','id',OLD.id) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','conversation','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_messages_insert AFTER INSERT ON messages
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'message',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_messages_update AFTER UPDATE ON messages
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.run_id IS NOT NEW.run_id OR OLD.role IS NOT NEW.role OR OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.created_at IS NOT NEW.created_at OR OLD.update_key IS NOT NEW.update_key OR OLD.transcript_ordinal IS NOT NEW.transcript_ordinal)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'message',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_messages_delete BEFORE DELETE ON messages
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','message','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifacts_insert AFTER INSERT ON artifacts
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'artifact',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifacts_update AFTER UPDATE ON artifacts
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.run_id IS NOT NEW.run_id OR OLD.title IS NOT NEW.title OR OLD.kind IS NOT NEW.kind OR OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.folder_id IS NOT NEW.folder_id OR OLD.pinned IS NOT NEW.pinned OR OLD.archived IS NOT NEW.archived OR OLD.version IS NOT NEW.version OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.feed_hidden IS NOT NEW.feed_hidden)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'artifact',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifacts_delete BEFORE DELETE ON artifacts
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','artifact','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_approvals_insert AFTER INSERT ON approvals
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'approval',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','approvals'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id AND owner_id=NEW.owner_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id AND owner_id=NEW.owner_id)) ELSE json_object('kind','collection','id','approvals') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_approvals_update AFTER UPDATE ON approvals
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.digest IS NOT NEW.digest OR OLD.request IS NOT NEW.request OR OLD.state IS NOT NEW.state OR OLD.result IS NOT NEW.result OR OLD.created_at IS NOT NEW.created_at OR OLD.expires_at IS NOT NEW.expires_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'approval',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','approvals'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id AND owner_id=NEW.owner_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id AND owner_id=NEW.owner_id)) ELSE json_object('kind','collection','id','approvals') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_approvals_delete BEFORE DELETE ON approvals
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','approvals','tombstone',json_object('scope',json_object('kind','collection','id','approvals'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id AND owner_id=OLD.owner_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id AND owner_id=OLD.owner_id)) ELSE json_object('kind','collection','id','approvals') END),'removed',json_object('kind','approval','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_later_items_insert AFTER INSERT ON later_items
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'later',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','later'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_later_items_update AFTER UPDATE ON later_items
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.kind IS NOT NEW.kind OR OLD.target_id IS NOT NEW.target_id OR OLD.condition IS NOT NEW.condition OR OLD.due_at IS NOT NEW.due_at OR OLD.project_id IS NOT NEW.project_id OR OLD.created_at IS NOT NEW.created_at OR OLD.surfaced_at IS NOT NEW.surfaced_at OR OLD.done_at IS NOT NEW.done_at OR OLD.snoozes IS NOT NEW.snoozes)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'later',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','later'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_later_items_delete BEFORE DELETE ON later_items
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','later','tombstone',json_object('scope',json_object('kind','collection','id','later'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','saved')),'removed',json_object('kind','later','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_scheduled_sends_insert AFTER INSERT ON scheduled_sends
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'scheduled_send',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','scheduled'),'scopes',json_array(json_object('kind','collection','id','feed'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','scheduled') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_scheduled_sends_update AFTER UPDATE ON scheduled_sends
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.folder_id IS NOT NEW.folder_id OR OLD.folder_chosen IS NOT NEW.folder_chosen OR OLD.input IS NOT NEW.input OR OLD.attachment_ids IS NOT NEW.attachment_ids OR OLD.reply_to_message_id IS NOT NEW.reply_to_message_id OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.send_at IS NOT NEW.send_at OR OLD.state IS NOT NEW.state OR OLD.run_id IS NOT NEW.run_id OR OLD.error IS NOT NEW.error OR OLD.created_at IS NOT NEW.created_at OR OLD.reply_excerpt IS NOT NEW.reply_excerpt)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'scheduled_send',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','scheduled'),'scopes',json_array(json_object('kind','collection','id','feed'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','scheduled') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_scheduled_sends_delete BEFORE DELETE ON scheduled_sends
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','scheduled','tombstone',json_object('scope',json_object('kind','collection','id','scheduled'),'scopes',json_array(json_object('kind','collection','id','feed'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','scheduled') END),'removed',json_object('kind','scheduled_send','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_threads_insert AFTER INSERT ON agent_threads
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'mail_thread',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','mail'),'scopes',json_array(json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_threads_update AFTER UPDATE ON agent_threads
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.team_id IS NOT NEW.team_id OR OLD.subject IS NOT NEW.subject OR OLD.created_by IS NOT NEW.created_by OR OLD.paused_at IS NOT NEW.paused_at OR OLD.paused_reason IS NOT NEW.paused_reason OR OLD.resumed_at IS NOT NEW.resumed_at OR OLD.resumed_order IS NOT NEW.resumed_order OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'mail_thread',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','mail'),'scopes',json_array(json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_threads_delete BEFORE DELETE ON agent_threads
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','mail','tombstone',json_object('scope',json_object('kind','collection','id','mail'),'scopes',json_array(json_object('kind','collection','id','feed')),'removed',json_object('kind','mail_thread','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_connections_insert AFTER INSERT ON connections
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'connection',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_connections_update AFTER UPDATE ON connections
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR OLD.label IS NOT NEW.label OR OLD.secret IS NOT NEW.secret OR OLD.status IS NOT NEW.status OR OLD.models IS NOT NEW.models OR OLD.metadata IS NOT NEW.metadata OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'connection',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_connections_delete BEFORE DELETE ON connections
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results')),'removed',json_object('kind','connection','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agents_insert AFTER INSERT ON agents
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'agent',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agents_update AFTER UPDATE ON agents
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.name IS NOT NEW.name OR OLD.normalized_name IS NOT NEW.normalized_name OR OLD.provider IS NOT NEW.provider OR OLD.connection_id IS NOT NEW.connection_id OR OLD.model IS NOT NEW.model OR OLD.instructions IS NOT NEW.instructions OR OLD.origin IS NOT NEW.origin OR OLD.created_at IS NOT NEW.created_at OR OLD.folder_id IS NOT NEW.folder_id OR OLD.effort IS NOT NEW.effort OR OLD.retired_at IS NOT NEW.retired_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'agent',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agents_delete BEFORE DELETE ON agents
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved')),'removed',json_object('kind','agent','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_folders_insert AFTER INSERT ON folders
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'folder',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id','later'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_folders_update AFTER UPDATE ON folders
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.kind IS NOT NEW.kind OR OLD.name IS NOT NEW.name OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'folder',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id','later'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_folders_delete BEFORE DELETE ON folders
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id','later')),'removed',json_object('kind','folder','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_teams_insert AFTER INSERT ON teams
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'team',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','mail'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_teams_update AFTER UPDATE ON teams
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.name IS NOT NEW.name OR OLD.manager_id IS NOT NEW.manager_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.created_at IS NOT NEW.created_at OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.preset_id IS NOT NEW.preset_id OR OLD.preset_version IS NOT NEW.preset_version OR OLD.preset_config IS NOT NEW.preset_config OR OLD.folder_id IS NOT NEW.folder_id OR OLD.hide_results_from_feed IS NOT NEW.hide_results_from_feed)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'team',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','mail'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_teams_delete BEFORE DELETE ON teams
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','mail')),'removed',json_object('kind','team','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_sources_insert AFTER INSERT ON feed_sources
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'social',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_sources_update AFTER UPDATE ON feed_sources
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.url IS NOT NEW.url OR OLD.title IS NOT NEW.title OR OLD.home IS NOT NEW.home OR OLD.category IS NOT NEW.category OR OLD.kind IS NOT NEW.kind OR OLD.color IS NOT NEW.color OR OLD.created_at IS NOT NEW.created_at OR OLD.read_through_at IS NOT NEW.read_through_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'social',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_sources_delete BEFORE DELETE ON feed_sources
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','saved')),'removed',json_object('kind','social','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_native_decisions_insert AFTER INSERT ON native_decisions
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NULL,'decision',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','decisions'),'scopes',json_array(json_object('kind','collection','id','approvals'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','decisions') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_native_decisions_update AFTER UPDATE ON native_decisions
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.run_id IS NOT NEW.run_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.generation IS NOT NEW.generation OR OLD.native_id IS NOT NEW.native_id OR OLD.request IS NOT NEW.request OR OLD.state IS NOT NEW.state OR OLD.command_id IS NOT NEW.command_id OR OLD.digest IS NOT NEW.digest OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NULL,'decision',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','decisions'),'scopes',json_array(json_object('kind','collection','id','approvals'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','decisions') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_native_decisions_delete BEFORE DELETE ON native_decisions
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','decisions','tombstone',json_object('scope',json_object('kind','collection','id','decisions'),'scopes',json_array(json_object('kind','collection','id','approvals'),json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','decisions') END),'removed',json_object('kind','decision','id',OLD.id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_mail_insert AFTER INSERT ON agent_mail
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'mail_thread',NEW.thread_id,'invalidate',json_object('scope',json_object('kind','collection','id','mail'),'scopes',json_array(json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_mail_update AFTER UPDATE ON agent_mail
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.team_id IS NOT NEW.team_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.kind IS NOT NEW.kind OR OLD.sender_agent_id IS NOT NEW.sender_agent_id OR OLD.sender_run_id IS NOT NEW.sender_run_id OR OLD.sender_conversation_id IS NOT NEW.sender_conversation_id OR OLD.recipient_agent_id IS NOT NEW.recipient_agent_id OR OLD.recipient_conversation_id IS NOT NEW.recipient_conversation_id OR OLD.body IS NOT NEW.body OR OLD.file_ids IS NOT NEW.file_ids OR OLD.interrupt IS NOT NEW.interrupt OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.request IS NOT NEW.request OR OLD.state IS NOT NEW.state OR OLD.error IS NOT NEW.error OR OLD.delivery IS NOT NEW.delivery OR OLD.run_id IS NOT NEW.run_id OR OLD.steering_id IS NOT NEW.steering_id OR OLD.requeued_run_id IS NOT NEW.requeued_run_id OR OLD.created_at IS NOT NEW.created_at OR OLD.sent_at IS NOT NEW.sent_at OR OLD.retry_at IS NOT NEW.retry_at OR OLD.attempts IS NOT NEW.attempts)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'mail_thread',NEW.thread_id,'invalidate',json_object('scope',json_object('kind','collection','id','mail'),'scopes',json_array(json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_mail_delete BEFORE DELETE ON agent_mail
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','mail','tombstone',json_object('scope',json_object('kind','collection','id','mail'),'scopes',json_array(json_object('kind','collection','id','feed')),'removed',json_object('kind','mail_thread','id',OLD.thread_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_team_members_insert AFTER INSERT ON team_members
WHEN (SELECT owner_id FROM teams WHERE id=NEW.team_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM teams WHERE id=NEW.team_id),NULL,'team',NEW.team_id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','mail'),json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_team_members_update AFTER UPDATE ON team_members
WHEN (SELECT owner_id FROM teams WHERE id=NEW.team_id) IS NOT NULL AND (OLD.team_id IS NOT NEW.team_id OR OLD.agent_id IS NOT NEW.agent_id)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM teams WHERE id=NEW.team_id),NULL,'team',NEW.team_id,'invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','mail'),json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_team_members_delete BEFORE DELETE ON team_members
WHEN (SELECT owner_id FROM teams WHERE id=OLD.team_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM teams WHERE id=OLD.team_id),NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','mail'),json_object('kind','collection','id','feed')),'removed',json_object('kind','team','id',OLD.team_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_bookmarks_insert AFTER INSERT ON artifact_bookmarks
WHEN (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id),NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_bookmarks_update AFTER UPDATE ON artifact_bookmarks
WHEN (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id) IS NOT NULL AND (OLD.sequence IS NOT NEW.sequence OR OLD.artifact_id IS NOT NEW.artifact_id OR OLD.saved_at IS NOT NEW.saved_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id),NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_bookmarks_delete BEFORE DELETE ON artifact_bookmarks
WHEN (SELECT owner_id FROM artifacts WHERE id=OLD.artifact_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM artifacts WHERE id=OLD.artifact_id),NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results')),'removed',json_object('kind','artifact','id',OLD.artifact_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_objects_insert AFTER INSERT ON artifact_objects
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_objects_update AFTER UPDATE ON artifact_objects
WHEN NEW.owner_id IS NOT NULL AND (OLD.artifact_id IS NOT NEW.artifact_id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.call_id IS NOT NEW.call_id OR OLD.object_key IS NOT NEW.object_key OR OLD.mime IS NOT NEW.mime OR OLD.size IS NOT NEW.size OR OLD.checksum IS NOT NEW.checksum)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_objects_delete BEFORE DELETE ON artifact_objects
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results')),'removed',json_object('kind','artifact','id',OLD.artifact_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_publications_insert AFTER INSERT ON artifact_publications
WHEN (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id),NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_publications_update AFTER UPDATE ON artifact_publications
WHEN (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id) IS NOT NULL AND (OLD.sequence IS NOT NEW.sequence OR OLD.artifact_id IS NOT NEW.artifact_id)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM artifacts WHERE id=NEW.artifact_id),NULL,'artifact',NEW.artifact_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_artifact_publications_delete BEFORE DELETE ON artifact_publications
WHEN (SELECT owner_id FROM artifacts WHERE id=OLD.artifact_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM artifacts WHERE id=OLD.artifact_id),NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results')),'removed',json_object('kind','artifact','id',OLD.artifact_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_message_bookmarks_insert AFTER INSERT ON message_bookmarks
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'message',NEW.message_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_message_bookmarks_update AFTER UPDATE ON message_bookmarks
WHEN NEW.owner_id IS NOT NULL AND (OLD.sequence IS NOT NEW.sequence OR OLD.owner_id IS NOT NEW.owner_id OR OLD.message_id IS NOT NEW.message_id OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'message',NEW.message_id,'invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_message_bookmarks_delete BEFORE DELETE ON message_bookmarks
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','feed')),'removed',json_object('kind','message','id',OLD.message_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_activities_insert AFTER INSERT ON agent_activities
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NEW.run_id,CASE WHEN NEW.conversation_id IS NOT NULL THEN 'conversation' ELSE 'run' END,COALESCE(NEW.conversation_id,NEW.run_id),'invalidate',json_object('scope',json_object('kind','collection','id','activities'),'scopes',json_array(CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','activities') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_activities_update AFTER UPDATE ON agent_activities
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.activity_key IS NOT NEW.activity_key OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.run_id IS NOT NEW.run_id OR OLD.kind IS NOT NEW.kind OR OLD.record IS NOT NEW.record OR OLD.sequence IS NOT NEW.sequence OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NEW.run_id,CASE WHEN NEW.conversation_id IS NOT NULL THEN 'conversation' ELSE 'run' END,COALESCE(NEW.conversation_id,NEW.run_id),'invalidate',json_object('scope',json_object('kind','collection','id','activities'),'scopes',json_array(CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','activities') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_activities_delete BEFORE DELETE ON agent_activities
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','activities','tombstone',json_object('scope',json_object('kind','collection','id','activities'),'scopes',json_array(CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','activities') END),'removed',json_object('kind',CASE WHEN OLD.conversation_id IS NOT NULL THEN 'conversation' ELSE 'run' END,'id',COALESCE(OLD.conversation_id,OLD.run_id))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watches_insert AFTER INSERT ON pr_watches
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watches_update AFTER UPDATE ON pr_watches
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.repo_owner IS NOT NEW.repo_owner OR OLD.repo_name IS NOT NEW.repo_name OR OLD.number IS NOT NEW.number OR OLD.state IS NOT NEW.state OR OLD.ended_reason IS NOT NEW.ended_reason OR OLD.error IS NOT NEW.error OR OLD.login IS NOT NEW.login OR OLD.head_sha IS NOT NEW.head_sha OR OLD.ci_sha IS NOT NEW.ci_sha OR OLD.ci_conclusion IS NOT NEW.ci_conclusion OR OLD.comment_cursor IS NOT NEW.comment_cursor OR OLD.review_comment_cursor IS NOT NEW.review_comment_cursor OR OLD.review_cursor IS NOT NEW.review_cursor OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.since_at IS NOT NEW.since_at OR OLD.ci_pending IS NOT NEW.ci_pending OR OLD.read_at IS NOT NEW.read_at OR OLD.seen_ci_sha IS NOT NEW.seen_ci_sha OR OLD.seen_ci_conclusion IS NOT NEW.seen_ci_conclusion)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watches_delete BEFORE DELETE ON pr_watches
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','pulls','tombstone',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','pulls') END),'removed',json_object('kind','conversation','id',OLD.conversation_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_done_card_dismissals_insert AFTER INSERT ON done_card_dismissals
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_done_card_dismissals_update AFTER UPDATE ON done_card_dismissals
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.card_key IS NOT NEW.card_key OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_done_card_dismissals_delete BEFORE DELETE ON done_card_dismissals
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','conversation','id',OLD.conversation_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_conversation_positions_insert AFTER INSERT ON conversation_positions
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_conversation_positions_update AFTER UPDATE ON conversation_positions
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.position_message_id IS NOT NEW.position_message_id)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.conversation_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(CASE WHEN NEW.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',NEW.conversation_id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_conversation_positions_delete BEFORE DELETE ON conversation_positions
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(CASE WHEN OLD.conversation_id IS NOT NULL THEN json_object('kind','conversation','id',OLD.conversation_id) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','conversation','id',OLD.conversation_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_checkpoints_insert AFTER INSERT ON agent_checkpoints
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_checkpoints_update AFTER UPDATE ON agent_checkpoints
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.run_id IS NOT NEW.run_id OR OLD.message_id IS NOT NEW.message_id OR OLD.artifact_id IS NOT NEW.artifact_id OR OLD.round IS NOT NEW.round OR OLD.history IS NOT NEW.history OR OLD.pending IS NOT NEW.pending OR OLD.output IS NOT NEW.output OR OLD.stage IS NOT NEW.stage)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_agent_checkpoints_delete BEFORE DELETE ON agent_checkpoints
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_delegations_insert AFTER INSERT ON delegations
WHEN (SELECT owner_id FROM runs WHERE id=NEW.parent_run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.parent_run_id),NEW.parent_run_id,'run',NEW.parent_run_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','runs'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.parent_run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.parent_run_id)) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_delegations_update AFTER UPDATE ON delegations
WHEN (SELECT owner_id FROM runs WHERE id=NEW.parent_run_id) IS NOT NULL AND (OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.call_id IS NOT NEW.call_id OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.arguments IS NOT NEW.arguments OR OLD.background IS NOT NEW.background)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.parent_run_id),NEW.parent_run_id,'run',NEW.parent_run_id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','runs'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.parent_run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.parent_run_id)) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_delegations_delete BEFORE DELETE ON delegations
WHEN (SELECT owner_id FROM runs WHERE id=OLD.parent_run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.parent_run_id),NULL,'collection','feed','tombstone',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','runs'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.parent_run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.parent_run_id)) ELSE json_object('kind','collection','id','feed') END),'removed',json_object('kind','run','id',OLD.parent_run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_memory_receipts_insert AFTER INSERT ON memory_receipts
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_memory_receipts_update AFTER UPDATE ON memory_receipts
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.run_id IS NOT NEW.run_id OR OLD.mode IS NOT NEW.mode OR OLD.sources IS NOT NEW.sources OR OLD.tokens IS NOT NEW.tokens OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_memory_receipts_delete BEFORE DELETE ON memory_receipts
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','runs') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_native_dispatch_insert AFTER INSERT ON native_dispatch
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','decisions'),json_object('kind','collection','id','feed'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_native_dispatch_update AFTER UPDATE ON native_dispatch
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.run_id IS NOT NEW.run_id OR OLD.generation IS NOT NEW.generation OR OLD.digest IS NOT NEW.digest OR OLD.state IS NOT NEW.state OR OLD.error IS NOT NEW.error OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','decisions'),json_object('kind','collection','id','feed'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_native_dispatch_delete BEFORE DELETE ON native_dispatch
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','decisions'),json_object('kind','collection','id','feed'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','runs') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_traces_insert AFTER INSERT ON run_traces
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','activities'),'scopes',json_array(json_object('kind','collection','id','runs'),json_object('kind','collection','id','saved'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','activities') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_traces_update AFTER UPDATE ON run_traces
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.trace_key IS NOT NEW.trace_key OR OLD.kind IS NOT NEW.kind OR OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.artifact_id IS NOT NEW.artifact_id OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','activities'),'scopes',json_array(json_object('kind','collection','id','runs'),json_object('kind','collection','id','saved'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','activities') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_traces_delete BEFORE DELETE ON run_traces
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','activities','tombstone',json_object('scope',json_object('kind','collection','id','activities'),'scopes',json_array(json_object('kind','collection','id','runs'),json_object('kind','collection','id','saved'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','activities') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_workflow_steps_insert AFTER INSERT ON workflow_steps
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','approvals'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_workflow_steps_update AFTER UPDATE ON workflow_steps
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.run_id IS NOT NEW.run_id OR OLD.step_id IS NOT NEW.step_id OR OLD.position IS NOT NEW.position OR OLD.state IS NOT NEW.state OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.approval_id IS NOT NEW.approval_id OR OLD.output IS NOT NEW.output OR OLD.artifact_id IS NOT NEW.artifact_id)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','approvals'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_workflow_steps_delete BEFORE DELETE ON workflow_steps
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','approvals'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','runs') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_checkouts_insert AFTER INSERT ON run_checkouts
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_checkouts_update AFTER UPDATE ON run_checkouts
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.generation IS NOT NEW.generation OR OLD.directory IS NOT NEW.directory OR OLD.source IS NOT NEW.source OR OLD.branch IS NOT NEW.branch OR OLD.base_ref IS NOT NEW.base_ref OR OLD.base_sha IS NOT NEW.base_sha OR OLD.start_head IS NOT NEW.start_head OR OLD.start_dirty IS NOT NEW.start_dirty OR OLD.start_untracked IS NOT NEW.start_untracked OR OLD.started_at IS NOT NEW.started_at OR OLD.state IS NOT NEW.state OR OLD.end_head IS NOT NEW.end_head OR OLD.ahead IS NOT NEW.ahead OR OLD.behind IS NOT NEW.behind OR OLD.files IS NOT NEW.files OR OLD.committed IS NOT NEW.committed OR OLD.working IS NOT NEW.working OR OLD.untracked IS NOT NEW.untracked OR OLD.patch IS NOT NEW.patch OR OLD.patch_bytes IS NOT NEW.patch_bytes OR OLD.patch_truncated IS NOT NEW.patch_truncated OR OLD.remote IS NOT NEW.remote OR OLD.overlap IS NOT NEW.overlap OR OLD.captured_late IS NOT NEW.captured_late OR OLD.capture_token IS NOT NEW.capture_token OR OLD.capture_started_at IS NOT NEW.capture_started_at OR OLD.capture_pending IS NOT NEW.capture_pending OR OLD.summary IS NOT NEW.summary OR OLD.ended_at IS NOT NEW.ended_at OR OLD.error IS NOT NEW.error OR OLD.start_patch IS NOT NEW.start_patch OR OLD.start_untracked_paths IS NOT NEW.start_untracked_paths)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_checkouts_delete BEFORE DELETE ON run_checkouts
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','runs') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_verifications_insert AFTER INSERT ON run_verifications
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_verifications_update AFTER UPDATE ON run_verifications
WHEN (SELECT owner_id FROM runs WHERE id=NEW.run_id) IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.generation IS NOT NEW.generation OR OLD.source_id IS NOT NEW.source_id OR OLD.kind IS NOT NEW.kind OR OLD.tools IS NOT NEW.tools OR OLD.command IS NOT NEW.command OR OLD.status IS NOT NEW.status OR OLD.exit_code IS NOT NEW.exit_code OR OLD.truncated IS NOT NEW.truncated OR OLD.output_tail IS NOT NEW.output_tail OR OLD.observed_at IS NOT NEW.observed_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=NEW.run_id),NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=NEW.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=NEW.run_id)) ELSE json_object('kind','collection','id','runs') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_run_verifications_delete BEFORE DELETE ON run_verifications
WHEN (SELECT owner_id FROM runs WHERE id=OLD.run_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM runs WHERE id=OLD.run_id),NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'scopes',json_array(json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM runs WHERE id=OLD.run_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM runs WHERE id=OLD.run_id)) ELSE json_object('kind','collection','id','runs') END),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watch_deliveries_insert AFTER INSERT ON pr_watch_deliveries
WHEN (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id),NULL,'conversation',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id),'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id)) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watch_deliveries_update AFTER UPDATE ON pr_watch_deliveries
WHEN (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL AND (OLD.watch_id IS NOT NEW.watch_id OR OLD.run_id IS NOT NEW.run_id OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id),NULL,'conversation',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id),'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id)) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watch_deliveries_delete BEFORE DELETE ON pr_watch_deliveries
WHEN (SELECT owner_id FROM pr_watches WHERE id=OLD.watch_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM pr_watches WHERE id=OLD.watch_id),NULL,'collection','pulls','tombstone',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM pr_watches WHERE id=OLD.watch_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=OLD.watch_id)) ELSE json_object('kind','collection','id','pulls') END),'removed',json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=OLD.watch_id))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watch_seen_insert AFTER INSERT ON pr_watch_seen
WHEN (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id),NULL,'conversation',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id),'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id)) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watch_seen_update AFTER UPDATE ON pr_watch_seen
WHEN (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL AND (OLD.watch_id IS NOT NEW.watch_id OR OLD.kind IS NOT NEW.kind OR OLD.item_id IS NOT NEW.item_id)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM pr_watches WHERE id=NEW.watch_id),NULL,'conversation',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id),'invalidate',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=NEW.watch_id)) ELSE json_object('kind','collection','id','pulls') END)),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_pr_watch_seen_delete BEFORE DELETE ON pr_watch_seen
WHEN (SELECT owner_id FROM pr_watches WHERE id=OLD.watch_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM pr_watches WHERE id=OLD.watch_id),NULL,'collection','pulls','tombstone',json_object('scope',json_object('kind','collection','id','pulls'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),CASE WHEN (SELECT conversation_id FROM pr_watches WHERE id=OLD.watch_id) IS NOT NULL THEN json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=OLD.watch_id)) ELSE json_object('kind','collection','id','pulls') END),'removed',json_object('kind','conversation','id',(SELECT conversation_id FROM pr_watches WHERE id=OLD.watch_id))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_dismissals_insert AFTER INSERT ON feed_dismissals
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_dismissals_update AFTER UPDATE ON feed_dismissals
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.feed_id IS NOT NEW.feed_id OR OLD.story_id IS NOT NEW.story_id OR OLD.dismissed_at IS NOT NEW.dismissed_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_dismissals_delete BEFORE DELETE ON feed_dismissals
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','saved')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_mutes_insert AFTER INSERT ON feed_mutes
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_mutes_update AFTER UPDATE ON feed_mutes
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.phrase IS NOT NEW.phrase OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_mutes_delete BEFORE DELETE ON feed_mutes
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_preferences_insert AFTER INSERT ON feed_preferences
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_preferences_update AFTER UPDATE ON feed_preferences
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_access IS NOT NEW.agent_access OR OLD.updated_at IS NOT NEW.updated_at OR OLD.images IS NOT NEW.images)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_preferences_delete BEFORE DELETE ON feed_preferences
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_reads_insert AFTER INSERT ON feed_reads
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_reads_update AFTER UPDATE ON feed_reads
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.feed_id IS NOT NEW.feed_id OR OLD.story_id IS NOT NEW.story_id OR OLD.read_at IS NOT NEW.read_at OR OLD.is_read IS NOT NEW.is_read)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_reads_delete BEFORE DELETE ON feed_reads
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','saved')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_subscriptions_insert AFTER INSERT ON feed_subscriptions
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_subscriptions_update AFTER UPDATE ON feed_subscriptions
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.feed_id IS NOT NEW.feed_id OR OLD.created_at IS NOT NEW.created_at OR OLD.read_through_at IS NOT NEW.read_through_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_subscriptions_delete BEFORE DELETE ON feed_subscriptions
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','social')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_saved_labels_insert AFTER INSERT ON saved_labels
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','saved','invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_saved_labels_update AFTER UPDATE ON saved_labels
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.item_key IS NOT NEW.item_key OR OLD.label IS NOT NEW.label OR OLD.updated_at IS NOT NEW.updated_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','saved','invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_saved_labels_delete BEFORE DELETE ON saved_labels
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','saved')),'removed',json_object('kind','collection','id','saved')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_push_subscriptions_insert AFTER INSERT ON push_subscriptions
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','metadata'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_push_subscriptions_update AFTER UPDATE ON push_subscriptions
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.endpoint IS NOT NEW.endpoint OR OLD.subscription IS NOT NEW.subscription OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','metadata'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_push_subscriptions_delete BEFORE DELETE ON push_subscriptions
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','metadata')),'removed',json_object('kind','collection','id','metadata')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_workspace_projects_insert AFTER INSERT ON workspace_projects
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_workspace_projects_update AFTER UPDATE ON workspace_projects
WHEN NEW.owner_id IS NOT NULL AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.project_id IS NOT NEW.project_id)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','metadata','invalidate',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_workspace_projects_delete BEFORE DELETE ON workspace_projects
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','metadata','tombstone',json_object('scope',json_object('kind','collection','id','metadata'),'scopes',json_array(json_object('kind','collection','id','feed'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved')),'removed',json_object('kind','collection','id','metadata')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_objects_insert AFTER INSERT ON objects
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','saved','invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','results'),json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_objects_update AFTER UPDATE ON objects
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.name IS NOT NEW.name OR OLD.mime IS NOT NEW.mime OR OLD.bytes IS NOT NEW.bytes OR OLD.created_at IS NOT NEW.created_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','saved','invalidate',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','results'),json_object('kind','collection','id','feed'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_objects_delete BEFORE DELETE ON objects
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','saved','tombstone',json_object('scope',json_object('kind','collection','id','saved'),'scopes',json_array(json_object('kind','collection','id','results'),json_object('kind','collection','id','feed')),'removed',json_object('kind','collection','id','saved')),unixepoch('subsec')*1000;
END;

-- Digest settings and the worker's last-run/error status are Social state too.
CREATE TRIGGER change_feed_digests_insert AFTER INSERT ON feed_digests
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social')),unixepoch('subsec')*1000);
END;

CREATE TRIGGER change_feed_digests_update AFTER UPDATE ON feed_digests
WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id
 OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.feeds IS NOT NEW.feeds
 OR OLD.minute_of_day IS NOT NEW.minute_of_day OR OLD.zone IS NOT NEW.zone
 OR OLD.unread_only IS NOT NEW.unread_only OR OLD.enabled IS NOT NEW.enabled
 OR OLD.last_run_at IS NOT NEW.last_run_at OR OLD.last_error IS NOT NEW.last_error OR OLD.created_at IS NOT NEW.created_at
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social')),unixepoch('subsec')*1000);
END;

CREATE TRIGGER change_feed_digests_delete BEFORE DELETE ON feed_digests
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 VALUES(OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000);
END;

CREATE TRIGGER change_feed_watches_insert AFTER INSERT ON feed_watches
WHEN NEW.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_watches_update AFTER UPDATE ON feed_watches
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.query IS NOT NEW.query OR OLD.feeds IS NOT NEW.feeds OR OLD.created_at IS NOT NEW.created_at OR OLD.since_at IS NOT NEW.since_at OR OLD.enabled IS NOT NEW.enabled OR OLD.matches IS NOT NEW.matches OR OLD.last_match_at IS NOT NEW.last_match_at)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_watches_delete BEFORE DELETE ON feed_watches
WHEN OLD.owner_id IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_watch_hits_insert AFTER INSERT ON feed_watch_hits
WHEN (SELECT owner_id FROM feed_watches WHERE id=NEW.watch_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM feed_watches WHERE id=NEW.watch_id),NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_watch_hits_update AFTER UPDATE ON feed_watch_hits
WHEN (SELECT owner_id FROM feed_watches WHERE id=NEW.watch_id) IS NOT NULL AND (OLD.watch_id IS NOT NEW.watch_id OR OLD.feed_id IS NOT NEW.feed_id OR OLD.story_id IS NOT NEW.story_id OR OLD.matched_at IS NOT NEW.matched_at OR OLD.pushed IS NOT NEW.pushed)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM feed_watches WHERE id=NEW.watch_id),NULL,'collection','social','invalidate',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social'))),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_watch_hits_delete BEFORE DELETE ON feed_watch_hits
WHEN (SELECT owner_id FROM feed_watches WHERE id=OLD.watch_id) IS NOT NULL
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM feed_watches WHERE id=OLD.watch_id),NULL,'collection','social','tombstone',json_object('scope',json_object('kind','collection','id','social'),'scopes',json_array(json_object('kind','collection','id','social')),'removed',json_object('kind','collection','id','social')),unixepoch('subsec')*1000;
END;

CREATE TRIGGER change_feed_stories_insert AFTER INSERT ON feed_stories
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT owner_id,NULL,'collection','social','invalidate',
 '{"scope":{"kind":"collection","id":"social"},"scopes":[{"kind":"collection","id":"saved"},{"kind":"collection","id":"later"}]}',unixepoch('subsec')*1000
 FROM (SELECT owner_id FROM feed_subscriptions WHERE feed_id=NEW.feed_id UNION SELECT owner_id FROM feed_sources WHERE id=NEW.feed_id
 UNION SELECT owner_id FROM later_items WHERE kind='story' AND target_id=NEW.feed_id||':'||NEW.story_id);
END;

CREATE TRIGGER change_feed_stories_update AFTER UPDATE ON feed_stories
WHEN OLD.feed_id IS NOT NEW.feed_id OR OLD.story_id IS NOT NEW.story_id OR OLD.url IS NOT NEW.url OR OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.story IS NOT NEW.story OR OLD.published_at IS NOT NEW.published_at OR OLD.first_seen_at IS NOT NEW.first_seen_at
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT owner_id,NULL,'collection','social','invalidate',
 '{"scope":{"kind":"collection","id":"social"},"scopes":[{"kind":"collection","id":"saved"},{"kind":"collection","id":"later"}]}',unixepoch('subsec')*1000
 FROM (SELECT owner_id FROM feed_subscriptions WHERE feed_id=NEW.feed_id UNION SELECT owner_id FROM feed_sources WHERE id=NEW.feed_id
 UNION SELECT owner_id FROM later_items WHERE kind='story' AND target_id=NEW.feed_id||':'||NEW.story_id);
END;

CREATE TRIGGER change_feed_stories_delete BEFORE DELETE ON feed_stories
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT owner_id,NULL,'collection','social','tombstone',
 '{"scope":{"kind":"collection","id":"social"},"scopes":[{"kind":"collection","id":"saved"},{"kind":"collection","id":"later"}],"removed":{"kind":"collection","id":"social"}}',unixepoch('subsec')*1000
 FROM (SELECT owner_id FROM feed_subscriptions WHERE feed_id=OLD.feed_id UNION SELECT owner_id FROM feed_sources WHERE id=OLD.feed_id
 UNION SELECT owner_id FROM later_items WHERE kind='story' AND target_id=OLD.feed_id||':'||OLD.story_id);
END;

-- Expiry is a durable delivery obligation. Processing preserves the source
-- timestamps and read-time membership predicates, including after restart.
-- Native decisions have generation-bound expiry, not a timestamp/TTL.
CREATE TABLE change_expiries(
 owner_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('approval','watch')),
 subject_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
 PRIMARY KEY(owner_id,kind,subject_id)
);
CREATE INDEX change_expiries_due ON change_expiries(owner_id,processed,expires_at);
CREATE TABLE change_deadlines(owner_id TEXT PRIMARY KEY,next_deadline INTEGER);
INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
SELECT owner_id,'approval',id,expires_at FROM approvals WHERE state='pending';
INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE state NOT IN ('watching','paused');
CREATE TRIGGER change_approval_expiry_insert AFTER INSERT ON approvals WHEN NEW.state='pending' BEGIN
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'approval',id,expires_at FROM approvals WHERE id=NEW.id AND state='pending'
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_approval_expiry_update AFTER UPDATE OF owner_id,state,expires_at ON approvals
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.state IS NOT NEW.state OR OLD.expires_at IS NOT NEW.expires_at BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='approval' AND subject_id=OLD.id;
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'approval',id,expires_at FROM approvals WHERE id=NEW.id AND state='pending'
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_approval_expiry_delete BEFORE DELETE ON approvals BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='approval' AND subject_id=OLD.id;
END;
CREATE TRIGGER change_watch_expiry_insert AFTER INSERT ON pr_watches WHEN NEW.state NOT IN ('watching','paused') BEGIN
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE id=NEW.id AND state NOT IN ('watching','paused')
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_watch_expiry_update AFTER UPDATE OF owner_id,state,updated_at ON pr_watches
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.state IS NOT NEW.state OR OLD.updated_at IS NOT NEW.updated_at BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='watch' AND subject_id=OLD.id;
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE id=NEW.id AND state NOT IN ('watching','paused')
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_watch_expiry_delete BEFORE DELETE ON pr_watches BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='watch' AND subject_id=OLD.id;
END;

CREATE TRIGGER change_agent_thread_members_insert AFTER INSERT ON agent_thread_members WHEN (SELECT owner_id FROM agent_threads WHERE id=NEW.thread_id) IS NOT NULL BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) SELECT (SELECT owner_id FROM agent_threads WHERE id=NEW.thread_id),NULL,'mail_thread',NEW.thread_id,'invalidate',json_object('scope',json_object('kind','collection','id','mail')),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_agent_thread_members_update AFTER UPDATE ON agent_thread_members WHEN (SELECT owner_id FROM agent_threads WHERE id=NEW.thread_id) IS NOT NULL BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) SELECT (SELECT owner_id FROM agent_threads WHERE id=NEW.thread_id),NULL,'mail_thread',NEW.thread_id,'invalidate',json_object('scope',json_object('kind','collection','id','mail')),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_agent_thread_members_delete BEFORE DELETE ON agent_thread_members WHEN (SELECT owner_id FROM agent_threads WHERE id=OLD.thread_id) IS NOT NULL BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) SELECT (SELECT owner_id FROM agent_threads WHERE id=OLD.thread_id),NULL,'collection','mail','tombstone',json_object('scope',json_object('kind','collection','id','mail'),'removed',json_object('kind','mail_thread','id',OLD.thread_id)),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_run_steering_insert AFTER INSERT ON run_steering WHEN NEW.owner_id IS NOT NULL BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) SELECT NEW.owner_id,NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs')),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_run_steering_update AFTER UPDATE ON run_steering WHEN NEW.owner_id IS NOT NULL BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) SELECT NEW.owner_id,NEW.run_id,'run',NEW.run_id,'invalidate',json_object('scope',json_object('kind','collection','id','runs')),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_run_steering_delete BEFORE DELETE ON run_steering WHEN OLD.owner_id IS NOT NULL BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) SELECT OLD.owner_id,NULL,'collection','runs','tombstone',json_object('scope',json_object('kind','collection','id','runs'),'removed',json_object('kind','run','id',OLD.run_id)),unixepoch('subsec')*1000;
END;
CREATE TRIGGER change_feed_state_insert AFTER INSERT ON feed_state BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT owner_id,NULL,'collection','social','invalidate','{"scope":{"kind":"collection","id":"social"}}',unixepoch('subsec')*1000
 FROM (SELECT owner_id FROM feed_subscriptions WHERE feed_id=NEW.feed_id UNION SELECT owner_id FROM feed_sources WHERE id=NEW.feed_id);
END;
CREATE TRIGGER change_feed_state_update AFTER UPDATE ON feed_state
WHEN OLD.feed_id IS NOT NEW.feed_id OR OLD.title IS NOT NEW.title OR OLD.home IS NOT NEW.home OR OLD.failed_at IS NOT NEW.failed_at OR OLD.failures IS NOT NEW.failures OR OLD.error IS NOT NEW.error OR OLD.retry_at IS NOT NEW.retry_at OR OLD.stories IS NOT NEW.stories
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT owner_id,NULL,'collection','social','invalidate','{"scope":{"kind":"collection","id":"social"}}',unixepoch('subsec')*1000
 FROM (SELECT owner_id FROM feed_subscriptions WHERE feed_id=NEW.feed_id UNION SELECT owner_id FROM feed_sources WHERE id=NEW.feed_id);
END;
CREATE TRIGGER change_feed_state_delete BEFORE DELETE ON feed_state BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT owner_id,NULL,'collection','social','tombstone','{"scope":{"kind":"collection","id":"social"},"removed":{"kind":"collection","id":"social"}}',unixepoch('subsec')*1000
 FROM (SELECT owner_id FROM feed_subscriptions WHERE feed_id=OLD.feed_id UNION SELECT owner_id FROM feed_sources WHERE id=OLD.feed_id);
END;
INSERT INTO schema_version(version,applied_at) VALUES(108,unixepoch()*1000);
