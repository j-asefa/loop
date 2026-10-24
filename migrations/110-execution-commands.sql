-- 109 is reserved by the independently reviewed projection-delta branch.
-- An execution transport request is ephemeral; a command identity is durable.
CREATE TABLE execution_commands (
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  method TEXT NOT NULL,
  digest TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','completed','unknown')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,command_id)
);
CREATE INDEX execution_command_results ON execution_commands(owner_id,updated_at DESC) WHERE result IS NOT NULL;
INSERT INTO schema_version VALUES(110,unixepoch()*1000);
