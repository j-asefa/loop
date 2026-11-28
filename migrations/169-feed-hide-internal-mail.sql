-- Hide internal agent-to-agent mail and non-terminal/superseded review
-- continuation cards from Done, All, Outcomes and unread counts while keeping
-- raw transcripts, Agent Mail threads, Needs you approvals, and direct card
-- lookups intact.
ALTER TABLE feed_cards ADD COLUMN hide_internal INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS feed_cards_unread;
CREATE INDEX feed_cards_unread ON feed_cards(owner_id)
  WHERE kind='result' AND unread=1 AND hidden=0 AND hide_internal=0;
CREATE INDEX IF NOT EXISTS agent_mail_recipient_conversation
  ON agent_mail(owner_id, recipient_conversation_id)
  WHERE recipient_conversation_id IS NOT NULL;

CREATE TRIGGER project_feed_review_continuations_insert AFTER INSERT ON review_continuations BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT r.owner_id,r.conversation_id,'*' FROM runs r
    WHERE r.owner_id=NEW.owner_id AND r.id IN (NEW.parent_run_id,NEW.run_id) AND r.conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_review_continuations_update AFTER UPDATE ON review_continuations BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT r.owner_id,r.conversation_id,'*' FROM runs r
    WHERE r.owner_id=OLD.owner_id AND r.id IN (OLD.parent_run_id,OLD.run_id) AND r.conversation_id IS NOT NULL;
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT r.owner_id,r.conversation_id,'*' FROM runs r
    WHERE r.owner_id=NEW.owner_id AND r.id IN (NEW.parent_run_id,NEW.run_id) AND r.conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_review_continuations_delete BEFORE DELETE ON review_continuations BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT r.owner_id,r.conversation_id,'*' FROM runs r
    WHERE r.owner_id=OLD.owner_id AND r.id IN (OLD.parent_run_id,OLD.run_id) AND r.conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_agent_mail_insert AFTER INSERT ON agent_mail BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT NEW.owner_id,NEW.recipient_conversation_id,'*'
    WHERE NEW.owner_id IS NOT NULL AND NEW.recipient_conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_agent_mail_update AFTER UPDATE OF state,run_id,requeued_run_id,steering_id,recipient_conversation_id ON agent_mail WHEN OLD.state IS NOT NEW.state OR OLD.run_id IS NOT NEW.run_id OR OLD.requeued_run_id IS NOT NEW.requeued_run_id OR OLD.steering_id IS NOT NEW.steering_id OR OLD.recipient_conversation_id IS NOT NEW.recipient_conversation_id BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT OLD.owner_id,OLD.recipient_conversation_id,'*'
    WHERE OLD.owner_id IS NOT NULL AND OLD.recipient_conversation_id IS NOT NULL;
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT NEW.owner_id,NEW.recipient_conversation_id,'*'
    WHERE NEW.owner_id IS NOT NULL AND NEW.recipient_conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_agent_mail_delete BEFORE DELETE ON agent_mail BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT OLD.owner_id,OLD.recipient_conversation_id,'*'
    WHERE OLD.owner_id IS NOT NULL AND OLD.recipient_conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_agent_retired_continuations AFTER UPDATE OF retired_at ON agents WHEN OLD.retired_at IS NOT NEW.retired_at BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT r.owner_id,r.conversation_id,'*' FROM review_continuations rc
    JOIN runs r ON r.id=rc.run_id AND r.owner_id=rc.owner_id
    WHERE rc.owner_id=NEW.owner_id AND r.agent_id=NEW.id AND r.state='queued' AND r.conversation_id IS NOT NULL;
END;

CREATE TRIGGER project_feed_connection_status_continuations AFTER UPDATE OF status ON connections WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
    SELECT r.owner_id,r.conversation_id,'*' FROM review_continuations rc
    JOIN runs r ON r.id=rc.run_id AND r.owner_id=rc.owner_id
    WHERE rc.owner_id=NEW.owner_id AND json_extract(r.payload,'$.connectionId')=NEW.id AND r.state='queued' AND r.conversation_id IS NOT NULL;
END;

-- Re-project existing feed cards on upgrade so hide_internal and filtered
-- queued counts reflect historical mail and review-continuation records.
INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT DISTINCT owner_id,conversation_id,'*' FROM feed_cards;
