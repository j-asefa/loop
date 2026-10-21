CREATE TABLE card_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK(scope IN ('results:read','cards:read')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  request_window INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX card_tokens_owner ON card_tokens(owner_id,created_at DESC,id);
CREATE TABLE card_owner_limits (
  owner_id TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
-- Never reuse a creation identity or secret after revoked metadata is pruned.
CREATE TABLE card_token_ids(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,digest TEXT NOT NULL UNIQUE);
-- Authorization bookkeeping: removals reveal only identities this token has read.
CREATE TABLE card_token_reads(
  token_id TEXT NOT NULL REFERENCES card_tokens(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  PRIMARY KEY(token_id,owner_id,card_id)
);
INSERT INTO schema_version VALUES(98,unixepoch()*1000);
