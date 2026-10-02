-- A scheduled reply can quote only the part of a message you highlighted.
ALTER TABLE scheduled_sends ADD COLUMN reply_excerpt TEXT;
INSERT INTO schema_version VALUES(41,unixepoch()*1000);
