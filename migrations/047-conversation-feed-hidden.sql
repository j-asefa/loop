ALTER TABLE conversations ADD COLUMN feed_hidden INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version VALUES(47,unixepoch()*1000);
