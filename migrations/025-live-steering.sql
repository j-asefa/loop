CREATE TABLE run_steering (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','delivered','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX run_steering_pending ON run_steering(run_id,state,created_at);
-- A stopped worker must never leave a follow-up looking delivered, or replay
-- an input whose native outcome is unknown after recovery.
CREATE TRIGGER run_steering_stopped AFTER UPDATE OF state ON runs
WHEN NEW.state IN ('completed','failed','cancelled','interrupted')
BEGIN
  UPDATE run_steering SET state='failed',error=CASE state
    WHEN 'sending' THEN 'Delivery could not be confirmed before the run stopped. Review its messages before sending again.'
    ELSE 'The run ended before this message could be delivered. Send it again to continue.' END
    WHERE run_id=NEW.id AND state IN ('pending','sending');
END;
INSERT INTO schema_version VALUES(25,unixepoch()*1000);
