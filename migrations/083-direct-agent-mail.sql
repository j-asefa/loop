-- Rebuild the children before dropping their parent: migrations run inside an
-- immediate transaction with foreign keys ON. Keep rowids for equal-time order.
CREATE TABLE agent_threads_new(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'team' CHECK(scope IN ('team','direct')), team_id TEXT REFERENCES teams(id), subject TEXT NOT NULL, created_by TEXT NOT NULL, paused_at INTEGER, paused_reason TEXT, resumed_at INTEGER, resumed_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK((scope='team' AND team_id IS NOT NULL) OR (scope='direct' AND team_id IS NULL)));
INSERT INTO agent_threads_new(rowid,id,owner_id,team_id,subject,created_by,paused_at,paused_reason,resumed_at,created_at,updated_at) SELECT rowid,* FROM agent_threads;
UPDATE agent_threads_new SET resumed_order=(SELECT COALESCE(max(rowid),0) FROM agent_mail WHERE created_at<=agent_threads_new.resumed_at) WHERE resumed_at IS NOT NULL;
CREATE TABLE agent_thread_members_new(thread_id TEXT NOT NULL REFERENCES agent_threads_new(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, conversation_id TEXT, PRIMARY KEY(thread_id, agent_id));
INSERT INTO agent_thread_members_new(rowid,thread_id,agent_id,conversation_id) SELECT rowid,* FROM agent_thread_members;
CREATE TABLE agent_mail_new(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, team_id TEXT, thread_id TEXT NOT NULL REFERENCES agent_threads_new(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('message','result')), sender_agent_id TEXT NOT NULL, sender_run_id TEXT, sender_conversation_id TEXT, recipient_agent_id TEXT NOT NULL, recipient_conversation_id TEXT, body TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]', interrupt INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','sent','held','refused')), error TEXT, delivery TEXT, run_id TEXT, steering_id TEXT, requeued_run_id TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id, idempotency_key));
INSERT INTO agent_mail_new(rowid,id,owner_id,team_id,thread_id,kind,sender_agent_id,sender_run_id,sender_conversation_id,recipient_agent_id,recipient_conversation_id,body,file_ids,interrupt,idempotency_key,request,state,error,delivery,run_id,steering_id,requeued_run_id,created_at,sent_at) SELECT rowid,* FROM agent_mail;
DROP TABLE agent_mail;
DROP TABLE agent_thread_members;
DROP TABLE agent_threads;
ALTER TABLE agent_threads_new RENAME TO agent_threads;
ALTER TABLE agent_thread_members_new RENAME TO agent_thread_members;
ALTER TABLE agent_mail_new RENAME TO agent_mail;
CREATE INDEX agent_threads_team ON agent_threads(owner_id, team_id, updated_at);
CREATE INDEX agent_thread_members_agent ON agent_thread_members(agent_id, thread_id);
CREATE INDEX agent_mail_thread ON agent_mail(thread_id, created_at);
CREATE INDEX agent_mail_sender_run ON agent_mail(sender_run_id);
CREATE INDEX agent_mail_team ON agent_mail(owner_id, team_id, sent_at);
CREATE INDEX agent_mail_pair ON agent_mail(owner_id, sender_agent_id, recipient_agent_id, created_at);
CREATE INDEX agent_mail_steering ON agent_mail(steering_id) WHERE steering_id IS NOT NULL;
CREATE INDEX agent_mail_run ON agent_mail(run_id);
CREATE INDEX agent_mail_requeued ON agent_mail(requeued_run_id) WHERE requeued_run_id IS NOT NULL;
CREATE INDEX agent_mail_pending ON agent_mail(retry_at, created_at) WHERE state='pending';
CREATE INDEX agent_mail_pending_thread ON agent_mail(thread_id) WHERE state='pending';
INSERT INTO schema_version VALUES(83,unixepoch()*1000);
