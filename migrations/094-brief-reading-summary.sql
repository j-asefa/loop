-- Optional reading layer. Older records keep their wording until the next
-- normal brief generation; owner edits and pinned wording are preserved.
ALTER TABLE brief_items ADD COLUMN summary TEXT;

INSERT INTO schema_version VALUES(94,unixepoch()*1000);
