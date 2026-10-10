-- Stories you swiped away in Social. Like feed_reads, owner-scoped: the
-- stories themselves are shared, which ones you removed is yours.
CREATE TABLE feed_dismissals(owner_id TEXT NOT NULL, feed_id TEXT NOT NULL, story_id TEXT NOT NULL, dismissed_at INTEGER NOT NULL, PRIMARY KEY(owner_id, feed_id, story_id));
INSERT INTO schema_version VALUES(75,unixepoch()*1000);
