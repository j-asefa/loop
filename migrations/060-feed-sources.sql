-- Feeds an owner added by URL. The catalog is checked in and shared; these are
-- per-owner, so a feed one owner added is never read for another. Their
-- stories still cache in the shared feed_stories table keyed by this row's id,
-- which is derived from the address: two owners adding the same feed share one
-- copy, as they do for a catalog feed.
CREATE TABLE feed_sources(id TEXT NOT NULL, owner_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, home TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, color TEXT NOT NULL, created_at INTEGER NOT NULL, read_through_at INTEGER, PRIMARY KEY(owner_id, id));
CREATE INDEX feed_sources_owner ON feed_sources(owner_id, created_at);
INSERT INTO schema_version VALUES(60,unixepoch()*1000);
