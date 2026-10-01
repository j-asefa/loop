-- Return and defer: reading positions, message bookmarks, Later items, scheduled
-- sends, manual queue order and app-level push messages.

-- Where each owner stopped reading a thread, so it reopens there.
CREATE TABLE conversation_positions(owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, position_message_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id, conversation_id));

-- Saved messages. Saving again keeps the original position (idempotent).
-- Saving a reply that has a result pins that result instead, so a reply and
-- its result card are always saved together.
CREATE TABLE message_bookmarks(sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
CREATE INDEX message_bookmarks_owner ON message_bookmarks(owner_id, created_at);

-- Saved results and saved messages form one list ordered by when they were
-- saved. Earlier saves take their result's last change as the best estimate.
ALTER TABLE artifact_bookmarks ADD COLUMN saved_at INTEGER;
UPDATE artifact_bookmarks SET saved_at=(SELECT updated_at FROM artifacts WHERE id=artifact_id);
CREATE TRIGGER artifact_bookmarks_saved_at AFTER INSERT ON artifact_bookmarks WHEN new.saved_at IS NULL BEGIN
  UPDATE artifact_bookmarks SET saved_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE sequence=new.sequence;
END;

CREATE TABLE later_items(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('conversation','artifact','message')), target_id TEXT NOT NULL, condition TEXT NOT NULL CHECK(condition IN ('time','run_finished','project_open')), due_at INTEGER, project_id TEXT, created_at INTEGER NOT NULL, surfaced_at INTEGER, done_at INTEGER);
CREATE UNIQUE INDEX later_items_open ON later_items(owner_id,kind,target_id) WHERE done_at IS NULL;
CREATE INDEX later_items_waiting ON later_items(condition,due_at) WHERE done_at IS NULL AND surfaced_at IS NULL;

-- The stored idempotency key becomes the run's key, so a retried or crashed
-- delivery can never create a second run.
-- folder_chosen keeps "no project" (chosen, folder_id NULL) apart from "not
-- chosen" (the agent's default project applies when it is sent).
CREATE TABLE scheduled_sends(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), conversation_id TEXT REFERENCES conversations(id), folder_id TEXT, folder_chosen INTEGER NOT NULL DEFAULT 0, input TEXT NOT NULL, attachment_ids TEXT NOT NULL DEFAULT '[]', reply_to_message_id TEXT, idempotency_key TEXT NOT NULL, send_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('scheduled','submitted','cancelled','failed')), run_id TEXT, error TEXT, created_at INTEGER NOT NULL, UNIQUE(owner_id,idempotency_key));
CREATE INDEX scheduled_sends_due ON scheduled_sends(send_at) WHERE state='scheduled';

-- Manual reordering of queued work. NULL keeps enqueue order (created_at).
ALTER TABLE runs ADD COLUMN queue_rank REAL;

-- Conversation-scoped lookups used by the inbox, outline and usage views.
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);

-- App-level phone notifications (approvals, Later). Same lease and backoff as
-- push_deliveries; the message key is also the notification tag.
CREATE TABLE push_messages(subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE, message_key TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY(subscription_id,message_key));
CREATE INDEX push_messages_pending ON push_messages(available_at) WHERE delivered_at IS NULL;
-- Never include tool arguments: lock screens are not a place for request data.
-- Decisions are made inside the app, behind its device lock.
CREATE TRIGGER notify_approval AFTER INSERT ON approvals WHEN new.state='pending' BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'approval-'||new.id,
    COALESCE((SELECT '@'||g.name||' needs your approval' FROM runs r JOIN agents g ON g.id=r.agent_id WHERE r.id=new.run_id),'Approval needed'),
    'Open Loop to review the request.',
    COALESCE((SELECT '/?conversation='||r.conversation_id FROM runs r WHERE r.id=new.run_id),'/?page=inbox&filter=needs'),
    unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;
INSERT INTO schema_version VALUES(37,unixepoch()*1000);
