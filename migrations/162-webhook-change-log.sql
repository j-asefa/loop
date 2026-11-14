-- Webhook view changes share the durable workspace stream and deadline wake.
DROP TRIGGER change_approval_expiry_insert;
DROP TRIGGER change_approval_expiry_update;
DROP TRIGGER change_approval_expiry_delete;
DROP TRIGGER change_watch_expiry_insert;
DROP TRIGGER change_watch_expiry_update;
DROP TRIGGER change_watch_expiry_delete;
CREATE TABLE change_expiries_next(
 owner_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('approval','watch','webhook')),
 subject_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
 PRIMARY KEY(owner_id,kind,subject_id)
);
INSERT INTO change_expiries_next SELECT * FROM change_expiries;
DROP TABLE change_expiries;
ALTER TABLE change_expiries_next RENAME TO change_expiries;
CREATE INDEX change_expiries_due ON change_expiries(owner_id,processed,expires_at);
CREATE TRIGGER change_approval_expiry_insert AFTER INSERT ON approvals WHEN NEW.state='pending' BEGIN
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'approval',id,expires_at FROM approvals WHERE id=NEW.id AND state='pending'
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_approval_expiry_update AFTER UPDATE OF owner_id,state,expires_at ON approvals
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.state IS NOT NEW.state OR OLD.expires_at IS NOT NEW.expires_at BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='approval' AND subject_id=OLD.id;
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'approval',id,expires_at FROM approvals WHERE id=NEW.id AND state='pending'
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_approval_expiry_delete BEFORE DELETE ON approvals BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='approval' AND subject_id=OLD.id;
END;
CREATE TRIGGER change_watch_expiry_insert AFTER INSERT ON pr_watches WHEN NEW.state NOT IN ('watching','paused') BEGIN
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE id=NEW.id AND state NOT IN ('watching','paused')
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_watch_expiry_update AFTER UPDATE OF owner_id,state,updated_at ON pr_watches
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.state IS NOT NEW.state OR OLD.updated_at IS NOT NEW.updated_at BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='watch' AND subject_id=OLD.id;
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'watch',id,updated_at+604800000 FROM pr_watches WHERE id=NEW.id AND state NOT IN ('watching','paused')
 ON CONFLICT(owner_id,kind,subject_id) DO UPDATE SET expires_at=excluded.expires_at,
 processed=CASE WHEN change_expiries.expires_at=excluded.expires_at THEN change_expiries.processed ELSE 0 END;
END;
CREATE TRIGGER change_watch_expiry_delete BEFORE DELETE ON pr_watches BEGIN
 DELETE FROM change_expiries WHERE owner_id=OLD.owner_id AND kind='watch' AND subject_id=OLD.id;
END;

CREATE TRIGGER change_webhook_subscriptions_insert AFTER INSERT ON webhook_subscriptions
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','webhooks','invalidate',json_object('scope',json_object('kind','collection','id','webhooks')),unixepoch('subsec')*1000
 WHERE NEW.owner_id IS NOT NULL;
END;
CREATE TRIGGER change_webhook_subscriptions_update AFTER UPDATE ON webhook_subscriptions
WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.url IS NOT NEW.url OR OLD.kinds IS NOT NEW.kinds OR OLD.local IS NOT NEW.local OR OLD.state IS NOT NEW.state OR OLD.created_at IS NOT NEW.created_at OR OLD.activated_at IS NOT NEW.activated_at OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.failed_at IS NOT NEW.failed_at OR OLD.last_delivered_at IS NOT NEW.last_delivered_at OR OLD.last_status IS NOT NEW.last_status OR OLD.last_error IS NOT NEW.last_error OR OLD.last_attempts IS NOT NEW.last_attempts
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'collection','webhooks','invalidate',json_object('scope',json_object('kind','collection','id','webhooks')),unixepoch('subsec')*1000
 WHERE NEW.owner_id IS NOT NULL;
END;
CREATE TRIGGER change_webhook_subscriptions_delete BEFORE DELETE ON webhook_subscriptions
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT OLD.owner_id,NULL,'collection','webhooks','invalidate',json_object('scope',json_object('kind','collection','id','webhooks')),unixepoch('subsec')*1000
 WHERE OLD.owner_id IS NOT NULL;
END;
CREATE TRIGGER change_webhook_deliveries_insert AFTER INSERT ON webhook_deliveries
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM webhook_subscriptions WHERE id=NEW.subscription_id),NULL,'collection','webhooks','invalidate',json_object('scope',json_object('kind','collection','id','webhooks')),unixepoch('subsec')*1000
 WHERE (SELECT owner_id FROM webhook_subscriptions WHERE id=NEW.subscription_id) IS NOT NULL;
END;
CREATE TRIGGER change_webhook_deliveries_update AFTER UPDATE ON webhook_deliveries
WHEN OLD.id IS NOT NEW.id OR OLD.subscription_id IS NOT NEW.subscription_id OR OLD.event_id IS NOT NEW.event_id OR OLD.kind IS NOT NEW.kind OR OLD.purpose IS NOT NEW.purpose OR OLD.attempts IS NOT NEW.attempts OR OLD.available_at IS NOT NEW.available_at OR OLD.delivered_at IS NOT NEW.delivered_at OR OLD.last_status IS NOT NEW.last_status OR OLD.last_error IS NOT NEW.last_error OR OLD.outcome IS NOT NEW.outcome OR OLD.exhausted IS NOT NEW.exhausted OR OLD.leased_until IS NOT NEW.leased_until OR OLD.created_at IS NOT NEW.created_at
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM webhook_subscriptions WHERE id=NEW.subscription_id),NULL,'collection','webhooks','invalidate',json_object('scope',json_object('kind','collection','id','webhooks')),unixepoch('subsec')*1000
 WHERE (SELECT owner_id FROM webhook_subscriptions WHERE id=NEW.subscription_id) IS NOT NULL;
END;
CREATE TRIGGER change_webhook_deliveries_delete BEFORE DELETE ON webhook_deliveries
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT (SELECT owner_id FROM webhook_subscriptions WHERE id=OLD.subscription_id),NULL,'collection','webhooks','invalidate',json_object('scope',json_object('kind','collection','id','webhooks')),unixepoch('subsec')*1000
 WHERE (SELECT owner_id FROM webhook_subscriptions WHERE id=OLD.subscription_id) IS NOT NULL;
END;
CREATE TRIGGER change_webhook_expiry_insert AFTER INSERT ON webhook_deliveries
BEGIN
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'webhook',NEW.id,NEW.leased_until FROM webhook_subscriptions
 WHERE id=NEW.subscription_id AND NEW.leased_until IS NOT NULL;
END;
CREATE TRIGGER change_webhook_expiry_update AFTER UPDATE ON webhook_deliveries
WHEN OLD.id IS NOT NEW.id OR OLD.subscription_id IS NOT NEW.subscription_id OR OLD.leased_until IS NOT NEW.leased_until
BEGIN
 DELETE FROM change_expiries WHERE kind='webhook' AND subject_id=OLD.id;
 INSERT INTO change_expiries(owner_id,kind,subject_id,expires_at)
 SELECT owner_id,'webhook',NEW.id,NEW.leased_until FROM webhook_subscriptions
 WHERE id=NEW.subscription_id AND NEW.leased_until IS NOT NULL;
END;
CREATE TRIGGER change_webhook_expiry_delete BEFORE DELETE ON webhook_deliveries BEGIN
 DELETE FROM change_expiries WHERE kind='webhook' AND subject_id=OLD.id;
END;
