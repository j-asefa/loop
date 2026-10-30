-- Removing a read marker must refresh the card, unread count and change stream,
-- just as inserting one does when a result is opened.
CREATE TRIGGER project_feed_done_card_reads_delete AFTER DELETE ON done_card_reads BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) VALUES(OLD.owner_id,OLD.conversation_id,OLD.card_key) ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;
