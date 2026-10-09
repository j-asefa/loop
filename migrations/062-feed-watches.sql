-- A word or phrase you follow across the feeds you added. Matching happens on
-- stories Loop has already read, so a watch never causes a fetch.
CREATE TABLE feed_watches(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, query TEXT NOT NULL, feeds TEXT, created_at INTEGER NOT NULL, since_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, matches INTEGER NOT NULL DEFAULT 0, last_match_at INTEGER);
CREATE INDEX feed_watches_owner ON feed_watches(owner_id, created_at);
-- One row per story already announced for a watch, so a story is pushed once
-- even across restarts and retention passes.
CREATE TABLE feed_watch_hits(watch_id TEXT NOT NULL REFERENCES feed_watches(id) ON DELETE CASCADE, feed_id TEXT NOT NULL, story_id TEXT NOT NULL, matched_at INTEGER NOT NULL, pushed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(watch_id, feed_id, story_id));
CREATE INDEX feed_watch_hits_recent ON feed_watch_hits(watch_id, matched_at);
INSERT INTO schema_version VALUES(62,unixepoch()*1000);
