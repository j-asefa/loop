-- Stories from public feeds, cached once for every owner: a feed's contents
-- are the same for everyone who added it, and nothing here is owner state.
-- Loop keeps them so a restart does not empty Social, and so read marks,
-- saved stories and search have something durable to point at.
CREATE TABLE feed_stories(feed_id TEXT NOT NULL, story_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, story TEXT NOT NULL, published_at INTEGER, first_seen_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(feed_id, story_id));
-- Undated feeds sort by when Loop first read the story, so they interleave
-- with dated ones instead of collecting at the end of the list.
CREATE INDEX feed_stories_recent ON feed_stories(feed_id, COALESCE(published_at, first_seen_at) DESC);
-- One row per feed any owner added: when it was last read, whether it is
-- failing, and the validators that make a refresh cheap.
CREATE TABLE feed_state(feed_id TEXT PRIMARY KEY, title TEXT, home TEXT, fetched_at INTEGER, failed_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, error TEXT, retry_at INTEGER, etag TEXT, last_modified TEXT, stories INTEGER NOT NULL DEFAULT 0);
INSERT INTO schema_version VALUES(58,unixepoch()*1000);
