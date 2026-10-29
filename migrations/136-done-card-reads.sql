-- Done results the owner has opened, as Replies records read_at. Results that
-- existed before this table are history, not news, so they start read.
CREATE TABLE done_card_reads(
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  card_key TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,conversation_id,card_key)
) WITHOUT ROWID;

-- Seed from history rather than feed_cards: an upgrade from before the Feed
-- projection builds its cards only after every migration. Every possible
-- result identity is covered; a key that never becomes a result is unused.
INSERT INTO done_card_reads(owner_id,conversation_id,card_key,read_at)
SELECT r.owner_id,r.conversation_id,'run:'||r.id,unixepoch('subsec')*1000 FROM runs r
JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id WHERE r.state='completed'
UNION ALL
SELECT m.owner_id,m.conversation_id,'message:'||m.id,unixepoch('subsec')*1000 FROM messages m
JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id WHERE m.run_id IS NULL AND m.role='assistant';

-- The projector keeps the flag; the default leaves existing cards read without
-- rewriting them. The Done count reads only unread, visible results.
ALTER TABLE feed_cards ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
CREATE INDEX feed_cards_unread ON feed_cards(owner_id) WHERE kind='result' AND unread=1 AND hidden=0;

CREATE TRIGGER project_feed_done_card_reads_insert AFTER INSERT ON done_card_reads BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) VALUES(NEW.owner_id,NEW.conversation_id,NEW.card_key) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;
