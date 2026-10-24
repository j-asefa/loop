-- Application-owned Feed cards. Dirty identities are transaction-local work:
-- the production Database boundary drains them before committing a writer.
CREATE TABLE feed_cards (
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('thread','result','idle')),
  card_key TEXT NOT NULL,
  folder_id TEXT,
  agent_id TEXT,
  team_id TEXT,
  sort_at INTEGER NOT NULL,
  needs_run INTEGER NOT NULL DEFAULT 0,
  approval_until INTEGER,
  working INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  snoozed INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  hide_results INTEGER NOT NULL DEFAULT 0,
  legacy_sort_at INTEGER NOT NULL,
  legacy_hidden INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(owner_id,conversation_id,kind,card_key)
) WITHOUT ROWID;
CREATE INDEX feed_cards_order ON feed_cards(owner_id,kind,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_folder ON feed_cards(owner_id,kind,folder_id,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_agent ON feed_cards(owner_id,kind,agent_id,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_team ON feed_cards(owner_id,kind,team_id,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_working ON feed_cards(owner_id,kind,working,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_queued ON feed_cards(owner_id,kind,queued,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_later ON feed_cards(owner_id,kind,snoozed,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_completed ON feed_cards(owner_id,kind,completed,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_needs ON feed_cards(owner_id,kind,needs_run,approval_until,sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_legacy ON feed_cards(owner_id,kind,legacy_sort_at DESC,conversation_id DESC,card_key DESC);
CREATE INDEX feed_cards_results ON feed_cards(owner_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind IN ('result','idle');
CREATE INDEX feed_cards_results_folder ON feed_cards(owner_id,folder_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind IN ('result','idle');
CREATE INDEX feed_cards_results_agent ON feed_cards(owner_id,agent_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind IN ('result','idle');
CREATE INDEX feed_cards_results_team ON feed_cards(owner_id,team_id,sort_at DESC,conversation_id DESC,card_key DESC) WHERE kind IN ('result','idle');
CREATE INDEX feed_cards_summary ON feed_cards(owner_id,kind,folder_id,agent_id,team_id,needs_run,approval_until,working,queued);
CREATE TABLE feed_card_dirty (
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  card_key TEXT NOT NULL,
  PRIMARY KEY(owner_id,conversation_id,card_key)
) WITHOUT ROWID;

CREATE TRIGGER project_feed_conversations_insert AFTER INSERT ON conversations BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.id,'*' WHERE NEW.owner_id IS NOT NULL AND NEW.id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_conversations_update AFTER UPDATE OF id,owner_id,title,agent_id,execution_connection_id,team_id,origin,project_id,created_at ON conversations WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.title IS NOT NEW.title OR OLD.agent_id IS NOT NEW.agent_id OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.team_id IS NOT NEW.team_id OR OLD.origin IS NOT NEW.origin OR OLD.project_id IS NOT NEW.project_id OR OLD.created_at IS NOT NEW.created_at BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.id,'*' WHERE OLD.owner_id IS NOT NULL AND OLD.id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.id,'*' WHERE NEW.owner_id IS NOT NULL AND NEW.id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_conversations_delete BEFORE DELETE ON conversations BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.id,'*' WHERE OLD.owner_id IS NOT NULL AND OLD.id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_runs_insert AFTER INSERT ON runs BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'run:'||NEW.id WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_runs_update AFTER UPDATE OF id,owner_id,conversation_id,agent_id,input,payload,state,worker_id,attention_dismissed_at,created_at,updated_at,error,queue_rank,active_since ON runs WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.input IS NOT NEW.input OR OLD.payload IS NOT NEW.payload OR OLD.state IS NOT NEW.state OR OLD.worker_id IS NOT NEW.worker_id OR OLD.attention_dismissed_at IS NOT NEW.attention_dismissed_at OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.error IS NOT NEW.error OR OLD.queue_rank IS NOT NEW.queue_rank OR OLD.active_since IS NOT NEW.active_since BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'run:'||OLD.id WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'run:'||NEW.id WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_runs_delete BEFORE DELETE ON runs BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'run:'||OLD.id WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_queue_insert AFTER INSERT ON runs BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=NEW.owner_id AND r.agent_id=NEW.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_queue_update AFTER UPDATE ON runs WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.state IS NOT NEW.state OR OLD.queue_rank IS NOT NEW.queue_rank OR OLD.created_at IS NOT NEW.created_at OR OLD.payload IS NOT NEW.payload BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=OLD.owner_id AND r.agent_id=OLD.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=NEW.owner_id AND r.agent_id=NEW.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_queue_delete BEFORE DELETE ON runs BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'' FROM runs r WHERE r.owner_id=OLD.owner_id AND r.agent_id=OLD.agent_id AND r.state='queued' AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_messages_insert AFTER INSERT ON messages BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,CASE WHEN NEW.run_id IS NULL THEN 'message:'||NEW.id ELSE 'run:'||NEW.run_id END WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_messages_update AFTER UPDATE OF id,owner_id,conversation_id,run_id,role,content,metadata,created_at ON messages WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.run_id IS NOT NEW.run_id OR OLD.role IS NOT NEW.role OR OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.created_at IS NOT NEW.created_at BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,CASE WHEN OLD.run_id IS NULL THEN 'message:'||OLD.id ELSE 'run:'||OLD.run_id END WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,CASE WHEN NEW.run_id IS NULL THEN 'message:'||NEW.id ELSE 'run:'||NEW.run_id END WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_messages_delete BEFORE DELETE ON messages BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,CASE WHEN OLD.run_id IS NULL THEN 'message:'||OLD.id ELSE 'run:'||OLD.run_id END WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_approvals_insert AFTER INSERT ON approvals BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_approvals_update AFTER UPDATE ON approvals BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_approvals_delete BEFORE DELETE ON approvals BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_agent_checkpoints_insert AFTER INSERT ON agent_checkpoints BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_agent_checkpoints_update AFTER UPDATE ON agent_checkpoints BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_agent_checkpoints_delete BEFORE DELETE ON agent_checkpoints BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_native_dispatch_insert AFTER INSERT ON native_dispatch BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_native_dispatch_update AFTER UPDATE ON native_dispatch BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_native_dispatch_delete BEFORE DELETE ON native_dispatch BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_run_checkouts_insert AFTER INSERT ON run_checkouts BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_run_checkouts_update AFTER UPDATE ON run_checkouts BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_run_checkouts_delete BEFORE DELETE ON run_checkouts BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_run_verifications_insert AFTER INSERT ON run_verifications BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_run_verifications_update AFTER UPDATE ON run_verifications BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_run_verifications_delete BEFORE DELETE ON run_verifications BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_native_decisions_insert AFTER INSERT ON native_decisions BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,NEW.conversation_id,'' FROM runs r WHERE r.id=NEW.run_id AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_native_decisions_update AFTER UPDATE ON native_decisions BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,OLD.conversation_id,'' FROM runs r WHERE r.id=OLD.run_id AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,NEW.conversation_id,'' FROM runs r WHERE r.id=NEW.run_id AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_native_decisions_delete BEFORE DELETE ON native_decisions BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,OLD.conversation_id,'' FROM runs r WHERE r.id=OLD.run_id AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_conversation_positions_insert AFTER INSERT ON conversation_positions BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'' WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_conversation_positions_update AFTER UPDATE ON conversation_positions BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'' WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'' WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_conversation_positions_delete BEFORE DELETE ON conversation_positions BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'' WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_pr_watches_insert AFTER INSERT ON pr_watches BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'' WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_pr_watches_update AFTER UPDATE OF id,owner_id,conversation_id,repo_owner,repo_name,number,state,ended_reason,error,head_sha,ci_sha,ci_conclusion,ci_pending,read_at,seen_ci_sha,seen_ci_conclusion,created_at,updated_at ON pr_watches WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.repo_owner IS NOT NEW.repo_owner OR OLD.repo_name IS NOT NEW.repo_name OR OLD.number IS NOT NEW.number OR OLD.state IS NOT NEW.state OR OLD.ended_reason IS NOT NEW.ended_reason OR OLD.error IS NOT NEW.error OR OLD.head_sha IS NOT NEW.head_sha OR OLD.ci_sha IS NOT NEW.ci_sha OR OLD.ci_conclusion IS NOT NEW.ci_conclusion OR OLD.ci_pending IS NOT NEW.ci_pending OR OLD.read_at IS NOT NEW.read_at OR OLD.seen_ci_sha IS NOT NEW.seen_ci_sha OR OLD.seen_ci_conclusion IS NOT NEW.seen_ci_conclusion OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'' WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,'' WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_pr_watches_delete BEFORE DELETE ON pr_watches BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,'' WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_later_items_insert AFTER INSERT ON later_items BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.target_id,'' WHERE NEW.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_later_items_update AFTER UPDATE ON later_items BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.target_id,'' WHERE OLD.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.target_id,'' WHERE NEW.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_later_items_delete BEFORE DELETE ON later_items BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.target_id,'' WHERE OLD.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_done_card_dismissals_insert AFTER INSERT ON done_card_dismissals BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,NEW.card_key WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_done_card_dismissals_update AFTER UPDATE ON done_card_dismissals BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,OLD.card_key WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.conversation_id,NEW.card_key WHERE NEW.owner_id IS NOT NULL AND NEW.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_done_card_dismissals_delete BEFORE DELETE ON done_card_dismissals BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.conversation_id,OLD.card_key WHERE OLD.owner_id IS NOT NULL AND OLD.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_message_bookmarks_insert AFTER INSERT ON message_bookmarks BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id=NEW.message_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_message_bookmarks_update AFTER UPDATE ON message_bookmarks BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id=OLD.message_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id=NEW.message_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_message_bookmarks_delete BEFORE DELETE ON message_bookmarks BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id=OLD.message_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_agents_insert AFTER INSERT ON agents BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id AND c.agent_id=NEW.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_agents_update AFTER UPDATE OF id,owner_id,name,provider ON agents WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.name IS NOT NEW.name OR OLD.provider IS NOT NEW.provider BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id AND c.agent_id=OLD.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id AND c.agent_id=NEW.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_agents_delete BEFORE DELETE ON agents BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id AND c.agent_id=OLD.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_teams_insert AFTER INSERT ON teams BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=NEW.owner_id AND c.team_id=NEW.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_teams_update AFTER UPDATE OF id,owner_id,deleted_at,hide_results_from_feed ON teams WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.hide_results_from_feed IS NOT NEW.hide_results_from_feed BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=OLD.owner_id AND c.team_id=OLD.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=NEW.owner_id AND c.team_id=NEW.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_teams_delete BEFORE DELETE ON teams BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=OLD.owner_id AND c.team_id=OLD.id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_folders_insert AFTER INSERT ON folders BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_folders_update AFTER UPDATE OF id,owner_id,parent_id,name,kind ON folders WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.name IS NOT NEW.name OR OLD.kind IS NOT NEW.kind BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_folders_delete BEFORE DELETE ON folders BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_workspace_projects_insert AFTER INSERT ON workspace_projects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_workspace_projects_update AFTER UPDATE ON workspace_projects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_workspace_projects_delete BEFORE DELETE ON workspace_projects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'*' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_connections_insert AFTER INSERT ON connections BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_connections_update AFTER UPDATE OF id,owner_id,metadata ON connections WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.metadata IS NOT NEW.metadata BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=NEW.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_connections_delete BEFORE DELETE ON connections BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT c.owner_id,c.id,'' FROM conversations c WHERE c.owner_id=OLD.owner_id ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifacts_insert AFTER INSERT ON artifacts BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM agent_checkpoints cp JOIN runs r ON r.id=cp.run_id WHERE cp.artifact_id=NEW.id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id=json_extract(NEW.metadata,'$.messageId') ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT NEW.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifacts_update AFTER UPDATE OF id,owner_id,run_id,conversation_id,content,metadata,pinned,archived ON artifacts WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.run_id IS NOT NEW.run_id OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.content IS NOT NEW.content OR OLD.metadata IS NOT NEW.metadata OR OLD.pinned IS NOT NEW.pinned OR OLD.archived IS NOT NEW.archived BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM agent_checkpoints cp JOIN runs r ON r.id=cp.run_id WHERE cp.artifact_id=OLD.id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id=json_extract(OLD.metadata,'$.messageId') ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT OLD.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM agent_checkpoints cp JOIN runs r ON r.id=cp.run_id WHERE cp.artifact_id=NEW.id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id=json_extract(NEW.metadata,'$.messageId') ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT NEW.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifacts_delete BEFORE DELETE ON artifacts BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM agent_checkpoints cp JOIN runs r ON r.id=cp.run_id WHERE cp.artifact_id=OLD.id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id=json_extract(OLD.metadata,'$.messageId') ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT OLD.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifact_objects_insert AFTER INSERT ON artifact_objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT NEW.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifact_objects_update AFTER UPDATE ON artifact_objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT OLD.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT NEW.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_artifact_objects_delete BEFORE DELETE ON artifact_objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT OLD.artifact_id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_objects_insert AFTER INSERT ON objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT a.id FROM artifacts a WHERE a.owner_id=NEW.owner_id AND json_extract(a.metadata,'$.objectId')=NEW.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_objects_update AFTER UPDATE OF id,owner_id,name,mime ON objects WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.name IS NOT NEW.name OR OLD.mime IS NOT NEW.mime BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT a.id FROM artifacts a WHERE a.owner_id=OLD.owner_id AND json_extract(a.metadata,'$.objectId')=OLD.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=NEW.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=NEW.owner_id AND entity='message' AND target_id IN (SELECT a.id FROM artifacts a WHERE a.owner_id=NEW.owner_id AND json_extract(a.metadata,'$.objectId')=NEW.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_objects_delete BEFORE DELETE ON objects BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT m.owner_id,m.conversation_id,CASE WHEN m.run_id IS NULL THEN 'message:'||m.id ELSE 'run:'||m.run_id END FROM messages m WHERE m.owner_id=OLD.owner_id AND m.id IN (SELECT object_id FROM card_attachment_refs WHERE owner_id=OLD.owner_id AND entity='message' AND target_id IN (SELECT a.id FROM artifacts a WHERE a.owner_id=OLD.owner_id AND json_extract(a.metadata,'$.objectId')=OLD.id)) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_delegations_insert AFTER INSERT ON delegations BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.parent_run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_delegations_update AFTER UPDATE ON delegations BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.parent_run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.parent_run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_delegations_delete BEFORE DELETE ON delegations BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.parent_run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_workflow_steps_insert AFTER INSERT ON workflow_steps BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_workflow_steps_update AFTER UPDATE ON workflow_steps BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=NEW.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_workflow_steps_delete BEFORE DELETE ON workflow_steps BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT r.owner_id,r.conversation_id,'run:'||r.id FROM runs r WHERE r.id=OLD.run_id AND r.conversation_id IS NOT NULL ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

-- Startup projects this backfill in the migration transaction before it commits.
INSERT INTO feed_card_dirty SELECT owner_id,id,'*' FROM conversations;
INSERT INTO schema_version VALUES(119,unixepoch()*1000);
