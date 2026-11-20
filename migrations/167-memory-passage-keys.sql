-- Passage keys are derived from the saved source revision. Reset the passage
-- backfill so older workspaces rebuild in bounded batches using the same path.
DROP TRIGGER memory_passage_delete;
DROP TABLE memory_passage_fts;
DELETE FROM memory_passages;
DELETE FROM memory_passage_backfill;

CREATE VIRTUAL TABLE memory_passage_fts USING fts5(
  source_id UNINDEXED, owner_id UNINDEXED, ordinal UNINDEXED, title, body, keys,
  tokenize='unicode61', content='', contentless_delete=1
);
CREATE TRIGGER memory_passage_delete AFTER DELETE ON memory_passages BEGIN
  DELETE FROM memory_passage_fts WHERE rowid = OLD.id;
END;
