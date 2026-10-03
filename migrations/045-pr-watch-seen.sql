-- Watched pull requests track each delivered comment, review comment and
-- review by id. GitHub numbers a review when its draft is started, not when
-- it is submitted, so a highest-id cursor skipped reviews submitted out of
-- order. The cursors stay as a floor for what earlier watches delivered.
CREATE TABLE pr_watch_seen(watch_id TEXT NOT NULL REFERENCES pr_watches(id) ON DELETE CASCADE, kind TEXT NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY(watch_id, kind, item_id));
-- When the agent last read the pull request (its card's fetch time): what
-- was posted after that comes back. NULL for earlier watches.
ALTER TABLE pr_watches ADD COLUMN since_at INTEGER;
INSERT INTO schema_version VALUES(45,unixepoch()*1000);
