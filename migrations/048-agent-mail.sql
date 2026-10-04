-- Messages that agents on one team send each other (loop_message). Each sent
-- message becomes an ordinary queued run or steering input in the recipient's
-- conversation; its delivery state is read from that record, not copied here.
CREATE TABLE agent_threads(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, team_id TEXT NOT NULL REFERENCES teams(id), subject TEXT NOT NULL, created_by TEXT NOT NULL, paused_at INTEGER, paused_reason TEXT, resumed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX agent_threads_team ON agent_threads(owner_id, team_id, updated_at);
-- Where each participant last sent or received in a thread, so a reply wakes
-- that conversation when the participant has no active work in the team.
CREATE TABLE agent_thread_members(thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, conversation_id TEXT, PRIMARY KEY(thread_id, agent_id));
-- held: kept while the thread is paused at its limit and sent on Resume.
-- refused: Loop could not submit it (for example, the recipient was retired).
CREATE TABLE agent_mail(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, team_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('message','result')), sender_agent_id TEXT NOT NULL, sender_run_id TEXT, sender_conversation_id TEXT, recipient_agent_id TEXT NOT NULL, recipient_conversation_id TEXT, body TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]', interrupt INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('sent','held','refused')), error TEXT, delivery TEXT, run_id TEXT, steering_id TEXT, requeued_run_id TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE(owner_id, idempotency_key));
CREATE INDEX agent_mail_thread ON agent_mail(thread_id, created_at);
CREATE INDEX agent_mail_sender_run ON agent_mail(sender_run_id);
CREATE INDEX agent_mail_team ON agent_mail(owner_id, team_id, sent_at);
CREATE INDEX agent_mail_steering ON agent_mail(steering_id) WHERE steering_id IS NOT NULL;
-- loop_delegate with wait:false. The manager keeps working; each worker's
-- result arrives later as a message instead of blocking the manager's run.
ALTER TABLE delegations ADD COLUMN background INTEGER NOT NULL DEFAULT 0;
CREATE INDEX delegations_background ON delegations(child_run_id) WHERE background=1;
INSERT INTO schema_version VALUES(48,unixepoch()*1000);
