-- Preserve credential identities, revocation history, rate windows and disclosed
-- card IDs while replacing the scalar grant constraint. Foreign keys stay on.
CREATE TEMP TABLE integration_token_reads_backup AS SELECT * FROM card_token_reads;
DROP TABLE card_token_reads;
CREATE TEMP TABLE integration_token_rows_backup AS SELECT * FROM card_tokens;
DROP TABLE card_tokens;
CREATE TABLE card_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK(json_valid(scope) AND json_type(scope)='array' AND json_array_length(scope)>0),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  request_window INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO card_tokens
SELECT id,owner_id,name,digest,json_array(scope),created_at,revoked_at,last_used_at,request_window,request_count
FROM integration_token_rows_backup;
DROP TABLE integration_token_rows_backup;
CREATE INDEX card_tokens_owner ON card_tokens(owner_id,created_at DESC,id);
CREATE TABLE card_token_reads (
  token_id TEXT NOT NULL REFERENCES card_tokens(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  PRIMARY KEY(token_id,owner_id,card_id)
);
INSERT INTO card_token_reads SELECT * FROM integration_token_reads_backup;
DROP TABLE integration_token_reads_backup;
