-- Capture the sender's accepted native generation before any remote IO.
-- Completed intents remain durable when an idle harness later restarts.
CREATE TABLE fleet_mail_dispatch(
  mail_id TEXT PRIMARY KEY REFERENCES agent_mail(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  native_generation TEXT,
  native INTEGER NOT NULL CHECK(native IN (0,1))
);
-- Receipt reconciliation survives deletion of the local conversation/thread.
ALTER TABLE fleet_mail_outbox ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_mail_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
