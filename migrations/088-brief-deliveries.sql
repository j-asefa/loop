-- The conversations whose native harness has received the project brief
-- behind a prompt. A harness keeps its context, so the brief goes once per
-- conversation; a turn the harness rejected before reading it leaves no
-- row, and the next turn carries the brief again.
CREATE TABLE brief_deliveries(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL
);

INSERT INTO schema_version VALUES(88,unixepoch()*1000);
