-- Deleting an unauthenticatable credential can discard its receipts. Revocation
-- alone retains them; credential identity tombstones prevent resurrection.
CREATE TABLE token_requests (
  owner_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES card_tokens(id) ON DELETE CASCADE,
  -- The registrar validates contract character bounds. SQLite length(TEXT)
  -- stops at NUL, so it cannot validate every accepted JSON string here.
  identity TEXT NOT NULL,
  operation TEXT,
  request_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  response_status INTEGER,
  locator TEXT CHECK(locator IS NULL OR json_valid(locator)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(owner_id,token_id,identity),
  CHECK((state='pending' AND response_status IS NULL AND locator IS NULL AND completed_at IS NULL)
    OR (state='complete' AND completed_at IS NOT NULL)),
  CHECK((operation IS NULL AND request_hash IS NULL AND response_status IS NULL AND locator IS NULL)
    OR (operation IS NOT NULL AND request_hash IS NOT NULL))
);
CREATE INDEX token_requests_completed ON token_requests(owner_id,token_id,completed_at)
  WHERE state='complete' AND operation IS NOT NULL;
