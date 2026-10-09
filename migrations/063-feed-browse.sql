-- Searching the stories Loop has stored. The text is public feed content, so
-- the index is shared like feed_stories itself; results are still filtered to
-- the feeds each owner follows. The summary moves into its own column so FTS5
-- can index it from the table rather than from the stored JSON.
ALTER TABLE feed_stories ADD COLUMN summary TEXT;
UPDATE feed_stories SET summary=json_extract(story,'$.summary');
CREATE VIRTUAL TABLE feed_search USING fts5(title, summary, content='feed_stories', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER feed_search_insert AFTER INSERT ON feed_stories BEGIN
  INSERT INTO feed_search(rowid,title,summary) VALUES(new.rowid,new.title,new.summary);
END;
CREATE TRIGGER feed_search_update AFTER UPDATE OF title,summary ON feed_stories BEGIN
  INSERT INTO feed_search(feed_search,rowid,title,summary) VALUES('delete',old.rowid,old.title,old.summary);
  INSERT INTO feed_search(rowid,title,summary) VALUES(new.rowid,new.title,new.summary);
END;
CREATE TRIGGER feed_search_delete AFTER DELETE ON feed_stories BEGIN
  INSERT INTO feed_search(feed_search,rowid,title,summary) VALUES('delete',old.rowid,old.title,old.summary);
END;
INSERT INTO feed_search(feed_search) VALUES('rebuild');
-- Words you never want to see in Social.
CREATE TABLE feed_mutes(owner_id TEXT NOT NULL, phrase TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, phrase));
-- Whether feed images load. A feed's image comes from the publisher, so
-- loading one tells that site you opened Social; off until you turn it on.
ALTER TABLE feed_preferences ADD COLUMN images INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version VALUES(63,unixepoch()*1000);
