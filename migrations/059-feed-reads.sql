-- What you have read in Social. Stories are shared across owners; which ones
-- you have read is yours, so it is a separate owner-scoped table.
-- is_read=0 is an explicit "unread again" for a story the watermark below
-- would otherwise cover, so marking one story unread survives a reload.
CREATE TABLE feed_reads(owner_id TEXT NOT NULL, feed_id TEXT NOT NULL, story_id TEXT NOT NULL, read_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(owner_id, feed_id, story_id));
-- "Mark all read" is a watermark rather than a row per story, so a feed with a
-- hundred stories costs one write.
ALTER TABLE feed_subscriptions ADD COLUMN read_through_at INTEGER;
-- later_items gains the 'story' kind, so a story can be saved beside a
-- conversation, an artifact and a message. SQLite cannot alter a CHECK
-- constraint, so the table is rebuilt with its columns and indexes as they
-- stand (037 created it, 038 added snoozes).
ALTER TABLE later_items RENAME TO later_items_old;
CREATE TABLE later_items(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('conversation','artifact','message','story')), target_id TEXT NOT NULL, condition TEXT NOT NULL CHECK(condition IN ('time','run_finished','project_open')), due_at INTEGER, project_id TEXT, created_at INTEGER NOT NULL, surfaced_at INTEGER, done_at INTEGER, snoozes INTEGER NOT NULL DEFAULT 0);
INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,project_id,created_at,surfaced_at,done_at,snoozes) SELECT id,owner_id,kind,target_id,condition,due_at,project_id,created_at,surfaced_at,done_at,snoozes FROM later_items_old;
-- A rebuild that loses a row is worse than one that fails: a count that does
-- not match fails this CHECK, and the migration's transaction rolls back.
CREATE TEMP TABLE later_items_rebuilt(every_row INTEGER NOT NULL CHECK(every_row=1));
INSERT INTO later_items_rebuilt SELECT (SELECT count(*) FROM later_items)=(SELECT count(*) FROM later_items_old);
DROP TABLE later_items_rebuilt;
DROP TABLE later_items_old;
CREATE UNIQUE INDEX later_items_open ON later_items(owner_id,kind,target_id) WHERE done_at IS NULL;
CREATE INDEX later_items_waiting ON later_items(condition,due_at) WHERE done_at IS NULL AND surfaced_at IS NULL;
INSERT INTO schema_version VALUES(59,unixepoch()*1000);
