-- Upgrade application-owned names without changing owner IDs, dispatch IDs,
-- signed fleet records, stored credentials or native session context.

DROP TRIGGER "notify_approval";
CREATE TRIGGER notify_approval AFTER INSERT ON approvals WHEN new.state='pending' BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'approval-'||new.id,
    COALESCE((SELECT '@'||g.name||' needs your approval' FROM runs r JOIN agents g ON g.id=r.agent_id WHERE r.id=new.run_id),'Approval needed'),
    'Open Loop55 to review the request.',
    COALESCE((SELECT '/?conversation='||r.conversation_id FROM runs r WHERE r.id=new.run_id),'/?page=inbox&filter=needs'),
    unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;

DROP TRIGGER "notify_native_attention";
CREATE TRIGGER notify_native_attention AFTER UPDATE OF state ON runs
WHEN new.state='awaiting_approval' AND old.state<>new.state BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'decision-'||d.id,'Needs you','Open Loop55 to answer or review the request.',
    '/?conversation='||new.conversation_id,unixepoch()*1000
  FROM native_decisions d JOIN push_subscriptions s ON s.owner_id=new.owner_id
  WHERE d.run_id=new.id AND d.state='pending';
END;

DROP TRIGGER "notify_run_attention";
CREATE TRIGGER notify_run_attention AFTER UPDATE OF state ON runs
WHEN new.state IN ('paused','failed','interrupted') AND old.state<>new.state AND new.conversation_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'run-attention-'||new.id||'-'||new.state||'-'||new.updated_at,'Needs you',
    CASE new.state WHEN 'paused' THEN 'Work is paused. Open Loop55 to continue.'
      WHEN 'failed' THEN 'Work failed. Open Loop55 to review it.' ELSE 'Work was interrupted. Open Loop55 to review it.' END,
    '/?conversation='||new.conversation_id,unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;

DROP TRIGGER "notify_scheduled_attention";
CREATE TRIGGER notify_scheduled_attention AFTER UPDATE OF state ON scheduled_sends
WHEN new.state='failed' AND old.state<>new.state BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'scheduled-'||new.id,'Needs you','A scheduled message could not be sent. Open Loop55 to review it.',
    '/?page=profile&later=scheduled&laterItem='||new.id,unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;

DROP TRIGGER "project_feed_connections_update";
CREATE TRIGGER project_feed_connections_update AFTER UPDATE ON connections WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR (json_extract(OLD.metadata,'$.loop55Harness') IS NOT NULL) IS NOT (json_extract(NEW.metadata,'$.loop55Harness') IS NOT NULL) BEGIN
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT r.owner_id,r.conversation_id,'' FROM runs r
WHERE r.owner_id=OLD.owner_id AND r.state='queued' AND r.conversation_id IS NOT NULL
  AND r.agent_id IN (SELECT q.agent_id FROM runs q WHERE q.owner_id=OLD.owner_id AND q.state='queued'
    AND json_extract(q.payload,'$.connectionId')=OLD.id)
ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
INSERT INTO feed_card_dirty(owner_id,conversation_id,card_key)
SELECT r.owner_id,r.conversation_id,'' FROM runs r
WHERE r.owner_id=NEW.owner_id AND r.state='queued' AND r.conversation_id IS NOT NULL
  AND r.agent_id IN (SELECT q.agent_id FROM runs q WHERE q.owner_id=NEW.owner_id AND q.state='queued'
    AND json_extract(q.payload,'$.connectionId')=NEW.id)
ON CONFLICT(owner_id,conversation_id,card_key) DO NOTHING;
END;

UPDATE connections SET metadata=json_remove(json_set(metadata,'$.loop55Harness',json_extract(metadata,'$.loopHarness')),'$.loopHarness')
WHERE json_type(metadata,'$.loopHarness') IS NOT NULL AND json_type(metadata,'$.loop55Harness') IS NULL;
UPDATE connections SET metadata=json_set(metadata,'$.runtimeKind','loop55-local')
WHERE json_extract(metadata,'$.runtimeKind')='loop-local';

-- The storage defaults in released migrations remain immutable. New inserts
-- use the current origin while existing owner/external identities stay scoped.
UPDATE agents SET origin='loop55' WHERE origin='loop';
UPDATE conversations SET origin='loop55' WHERE origin='loop';
CREATE TRIGGER loop55_agent_origin AFTER INSERT ON agents WHEN new.origin='loop' BEGIN
  UPDATE agents SET origin='loop55' WHERE id=new.id AND owner_id=new.owner_id;
END;
CREATE TRIGGER loop55_conversation_origin AFTER INSERT ON conversations WHEN new.origin='loop' BEGIN
  UPDATE conversations SET origin='loop55' WHERE id=new.id AND owner_id=new.owner_id;
END;
