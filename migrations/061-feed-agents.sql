-- Whether an agent may read your Social feed, and the digest Loop sends.
-- Agent access is off until you turn it on: the feed is yours to read, and a
-- tool that lists it puts what you follow into a model's context.
CREATE TABLE feed_preferences(owner_id TEXT PRIMARY KEY, agent_access INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
-- A digest Loop sends to an agent on a schedule. minute_of_day is local to
-- zone, so it stays at the same clock time across a daylight-saving change.
CREATE TABLE feed_digests(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent_id TEXT NOT NULL, conversation_id TEXT, feeds TEXT, minute_of_day INTEGER NOT NULL, zone TEXT NOT NULL, unread_only INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX feed_digests_due ON feed_digests(enabled, last_run_at);
INSERT INTO schema_version VALUES(61,unixepoch()*1000);
