-- Existing subscriptions keep their choices; new clients opt into Needs you only.
CREATE TABLE push_preferences (
  subscription_id TEXT PRIMARY KEY REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  needs_you INTEGER NOT NULL DEFAULT 1 CHECK(needs_you IN (0,1)),
  completed INTEGER NOT NULL DEFAULT 1 CHECK(completed IN (0,1)),
  reminders INTEGER NOT NULL DEFAULT 1 CHECK(reminders IN (0,1)),
  social INTEGER NOT NULL DEFAULT 1 CHECK(social IN (0,1))
);
INSERT INTO push_preferences(subscription_id) SELECT id FROM push_subscriptions;
CREATE TRIGGER initialize_push_preferences AFTER INSERT ON push_subscriptions BEGIN
  INSERT INTO push_preferences(subscription_id) VALUES(new.id);
END;
ALTER TABLE push_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'needsYou' CHECK(category IN ('needsYou','reminders','social'));
UPDATE push_messages SET category='reminders' WHERE message_key LIKE 'later-%';
UPDATE push_messages SET category='social' WHERE message_key LIKE 'feed-watch%';

CREATE TRIGGER filter_result_notifications BEFORE INSERT ON push_deliveries
WHEN EXISTS(SELECT 1 FROM push_preferences WHERE subscription_id=new.subscription_id AND completed=0)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER filter_message_notifications BEFORE INSERT ON push_messages
WHEN EXISTS(SELECT 1 FROM push_preferences WHERE subscription_id=new.subscription_id AND
  CASE new.category WHEN 'needsYou' THEN needs_you WHEN 'reminders' THEN reminders ELSE social END=0)
BEGIN SELECT RAISE(IGNORE); END;

-- Drop pending alerts when disabled, so re-enabling never replays them.
CREATE TRIGGER discard_disabled_notifications AFTER UPDATE ON push_preferences BEGIN
  DELETE FROM push_deliveries WHERE subscription_id=new.subscription_id AND delivered_at IS NULL AND new.completed=0;
  DELETE FROM push_messages WHERE subscription_id=new.subscription_id AND delivered_at IS NULL AND
    CASE category WHEN 'needsYou' THEN new.needs_you WHEN 'reminders' THEN new.reminders ELSE new.social END=0;
END;

-- Native questions and permissions only notify once the run actually waits.
-- Automatically allowed requests never enter this state.
CREATE TRIGGER notify_native_attention AFTER UPDATE OF state ON runs
WHEN new.state='awaiting_approval' AND old.state<>new.state BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'decision-'||d.id,'Needs you','Open Loop to answer or review the request.',
    '/?conversation='||new.conversation_id,unixepoch()*1000
  FROM native_decisions d JOIN push_subscriptions s ON s.owner_id=new.owner_id
  WHERE d.run_id=new.id AND d.state='pending';
END;
CREATE TRIGGER notify_run_attention AFTER UPDATE OF state ON runs
WHEN new.state IN ('paused','failed','interrupted') AND old.state<>new.state AND new.conversation_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'run-attention-'||new.id||'-'||new.state||'-'||new.updated_at,'Needs you',
    CASE new.state WHEN 'paused' THEN 'Work is paused. Open Loop to continue.'
      WHEN 'failed' THEN 'Work failed. Open Loop to review it.' ELSE 'Work was interrupted. Open Loop to review it.' END,
    '/?conversation='||new.conversation_id,unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;
CREATE TRIGGER notify_scheduled_attention AFTER UPDATE OF state ON scheduled_sends
WHEN new.state='failed' AND old.state<>new.state BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'scheduled-'||new.id,'Needs you','A scheduled message could not be sent. Open Loop to review it.',
    '/?page=profile&later=scheduled&laterItem='||new.id,unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;
