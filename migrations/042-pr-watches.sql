-- Pull requests a thread watches: the worker polls GitHub and queues CI
-- results, reviews and comments into that thread as follow-ups. Cursors record
-- what was already delivered, so a restart never sends an update twice.
CREATE TABLE pr_watches(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'watching', ended_reason TEXT, error TEXT, login TEXT, head_sha TEXT, ci_sha TEXT, ci_conclusion TEXT, comment_cursor INTEGER NOT NULL DEFAULT 0, review_comment_cursor INTEGER NOT NULL DEFAULT 0, review_cursor INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX pr_watches_active ON pr_watches(owner_id, lower(repo_owner), lower(repo_name), number) WHERE state IN ('watching','paused');
CREATE INDEX pr_watches_due ON pr_watches(state, next_poll_at);
CREATE INDEX pr_watches_conversation ON pr_watches(owner_id, conversation_id);
-- Each follow-up a watch queued, for its hourly turn limit.
CREATE TABLE pr_watch_deliveries(watch_id TEXT NOT NULL REFERENCES pr_watches(id) ON DELETE CASCADE, run_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX pr_watch_deliveries_watch ON pr_watch_deliveries(watch_id, created_at);
INSERT INTO schema_version VALUES(42,unixepoch()*1000);
