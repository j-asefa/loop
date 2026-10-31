-- Link each one-hop message identity to the existing local mail row. Receipt
-- tombstones live in the fleet journals even when a local thread is deleted.
CREATE TABLE fleet_mail_records(
  mail_id TEXT PRIMARY KEY REFERENCES agent_mail(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  sender_name TEXT NOT NULL,
  projection_pending INTEGER NOT NULL DEFAULT 0 CHECK(projection_pending IN (0,1)),
  UNIQUE(owner_id,peer_id,message_id,direction)
);
CREATE INDEX fleet_mail_records_owner ON fleet_mail_records(owner_id,mail_id);

-- Commit visible-projection work with the receipt itself. A terminal receipt
-- leaves the transport retry queue, but must still recover after a restart.
CREATE INDEX fleet_mail_records_projection ON fleet_mail_records(owner_id,mail_id)
  WHERE projection_pending=1;
CREATE TRIGGER fleet_mail_receipt_projection AFTER UPDATE OF state,receipt,local_refusal ON fleet_mail_outbox
WHEN NEW.state IN ('accepted','refused') AND
  (OLD.state IS NOT NEW.state OR OLD.receipt IS NOT NEW.receipt OR OLD.local_refusal IS NOT NEW.local_refusal)
BEGIN
  UPDATE fleet_mail_records SET projection_pending=1
    WHERE owner_id=NEW.owner_id AND mail_id=NEW.message_id AND direction='outgoing';
END;
