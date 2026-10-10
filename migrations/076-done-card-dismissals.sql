CREATE TABLE done_card_dismissals(
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  card_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,conversation_id,card_key)
);
-- The old flag hid whole conversations without recording which card was
-- swiped. It cannot safely be mapped to a result that may have arrived later.
UPDATE conversations SET feed_hidden=0 WHERE feed_hidden<>0;
INSERT INTO schema_version VALUES(76,unixepoch()*1000);
