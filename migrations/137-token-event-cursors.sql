-- Only client-confirmed cursors survive a disconnect. The current connection
-- identity fences acknowledgements from a replaced stream or API process.
CREATE TABLE token_event_cursors (
  token_id TEXT PRIMARY KEY REFERENCES card_tokens(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  epoch TEXT,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),
  connection_id TEXT NOT NULL
);
