-- The catalog feeds each owner added to Social. Feeds are public, so their
-- stories are cached once per feed in memory, not stored per owner.
CREATE TABLE feed_subscriptions(owner_id TEXT NOT NULL, feed_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, feed_id));
INSERT INTO schema_version VALUES(51,unixepoch()*1000);
