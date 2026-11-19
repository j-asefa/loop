CREATE TABLE memory_passages (
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  PRIMARY KEY (source_id, ordinal)
);
CREATE VIRTUAL TABLE memory_passage_fts USING fts5(
  source_id UNINDEXED, owner_id UNINDEXED, ordinal UNINDEXED, title, body,
  tokenize='unicode61', content='', contentless_delete=1
);
CREATE TRIGGER memory_passage_delete AFTER DELETE ON memory_passages BEGIN
  DELETE FROM memory_passage_fts WHERE rowid = OLD.rowid;
END;
CREATE TRIGGER memory_passage_tombstone AFTER UPDATE OF tombstone ON memory_sources
WHEN NEW.tombstone = 1 BEGIN
  DELETE FROM memory_passages WHERE source_id = NEW.id;
END;
CREATE TABLE memory_passage_backfill (complete INTEGER PRIMARY KEY CHECK (complete = 1));

-- Policy edits change revision without changing the indexed text or offsets.
CREATE TRIGGER memory_passage_policy_revision AFTER UPDATE OF revision ON memory_sources
WHEN NEW.tombstone = 0 AND NEW.revision <> OLD.revision
  AND NEW.title = OLD.title AND NEW.content = OLD.content BEGIN
  UPDATE memory_passages SET revision = NEW.revision
    WHERE source_id = NEW.id AND revision = OLD.revision;
END;
