-- A reminder that comes due moves its conversation's newest Done card to the
-- top. Mark reminder changes with their own dirty key so the projector also
-- re-projects that conversation's top result cards, not only its thread card.
DROP TRIGGER IF EXISTS project_feed_later_items_insert;
DROP TRIGGER IF EXISTS project_feed_later_items_update;
DROP TRIGGER IF EXISTS project_feed_later_items_delete;

CREATE TRIGGER project_feed_later_items_insert AFTER INSERT ON later_items BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.target_id,'later' WHERE NEW.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_later_items_update AFTER UPDATE ON later_items BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.target_id,'later' WHERE OLD.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT NEW.owner_id,NEW.target_id,'later' WHERE NEW.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

CREATE TRIGGER project_feed_later_items_delete BEFORE DELETE ON later_items BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key) SELECT OLD.owner_id,OLD.target_id,'later' WHERE OLD.kind='conversation' ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;
