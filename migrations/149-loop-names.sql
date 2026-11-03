-- Rename application-owned stored names back from Loop55 to Loop, without
-- changing owner IDs, dispatch IDs, signed fleet records, stored credentials
-- or native session context. Transcripts and traces keep their text.
-- Migration 139 (loop55-names) stays unchanged; this reverses its effects.

DROP TRIGGER "notify_approval";
CREATE TRIGGER notify_approval AFTER INSERT ON approvals WHEN new.state='pending' BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'approval-'||new.id,
    COALESCE((SELECT '@'||g.name||' needs your approval' FROM runs r JOIN agents g ON g.id=r.agent_id WHERE r.id=new.run_id),'Approval needed'),
    'Open Loop to review the request.',
    COALESCE((SELECT '/?conversation='||r.conversation_id FROM runs r WHERE r.id=new.run_id),'/?page=inbox&filter=needs'),
    unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;

DROP TRIGGER "notify_native_attention";
CREATE TRIGGER notify_native_attention AFTER UPDATE OF state ON runs
WHEN new.state='awaiting_approval' AND old.state<>new.state BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'decision-'||d.id,'Needs you','Open Loop to answer or review the request.',
    '/?conversation='||new.conversation_id,unixepoch()*1000
  FROM native_decisions d JOIN push_subscriptions s ON s.owner_id=new.owner_id
  WHERE d.run_id=new.id AND d.state='pending';
END;

DROP TRIGGER "notify_run_attention";
CREATE TRIGGER notify_run_attention AFTER UPDATE OF state ON runs
WHEN new.state IN ('paused','failed','interrupted') AND old.state<>new.state AND new.conversation_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'run-attention-'||new.id||'-'||new.state||'-'||new.updated_at,'Needs you',
    CASE new.state WHEN 'paused' THEN 'Work is paused. Open Loop to continue.'
      WHEN 'failed' THEN 'Work failed. Open Loop to review it.' ELSE 'Work was interrupted. Open Loop to review it.' END,
    '/?conversation='||new.conversation_id,unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;

DROP TRIGGER "notify_scheduled_attention";
CREATE TRIGGER notify_scheduled_attention AFTER UPDATE OF state ON scheduled_sends
WHEN new.state='failed' AND old.state<>new.state BEGIN
  INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at)
  SELECT s.id,'scheduled-'||new.id,'Needs you','A scheduled message could not be sent. Open Loop to review it.',
    '/?page=profile&later=scheduled&laterItem='||new.id,unixepoch()*1000
  FROM push_subscriptions s WHERE s.owner_id=new.owner_id;
END;

DROP TRIGGER "project_feed_connections_update";
CREATE TRIGGER project_feed_connections_update AFTER UPDATE ON connections WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR (json_extract(OLD.metadata,'$.loopHarness') IS NOT NULL) IS NOT (json_extract(NEW.metadata,'$.loopHarness') IS NOT NULL) BEGIN
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

UPDATE connections SET metadata=json_remove(json_set(metadata,'$.loopHarness',json_extract(metadata,'$.loop55Harness')),'$.loop55Harness')
WHERE json_type(metadata,'$.loop55Harness') IS NOT NULL AND json_type(metadata,'$.loopHarness') IS NULL;
UPDATE connections SET metadata=json_set(metadata,'$.runtimeKind','loop-local')
WHERE json_extract(metadata,'$.runtimeKind')='loop55-local';

-- New rows already default to origin 'loop'; stop rewriting them to 'loop55'.
DROP TRIGGER loop55_agent_origin;
DROP TRIGGER loop55_conversation_origin;
UPDATE agents SET origin='loop' WHERE origin='loop55';
UPDATE conversations SET origin='loop' WHERE origin='loop55';
UPDATE memory_sources SET origin='loop' WHERE origin='loop55';
UPDATE events SET payload=replace(payload,'"origin":"loop55"','"origin":"loop"')
WHERE type='approval.decided' AND instr(payload,'"origin":"loop55"')>0;
UPDATE feed_cards SET payload=replace(payload,'"origin":"loop55"','"origin":"loop"')
WHERE instr(payload,'"origin":"loop55"')>0;
