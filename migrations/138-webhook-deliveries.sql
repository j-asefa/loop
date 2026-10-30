CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, url TEXT NOT NULL,
  secret_sealed TEXT NOT NULL, creation_digest TEXT NOT NULL,
  kinds TEXT NOT NULL, local INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending_activation','active','failed','revoked')),
  created_at INTEGER NOT NULL, activated_at INTEGER, revoked_at INTEGER,
  failed_at INTEGER, last_delivered_at INTEGER, last_status INTEGER, last_error TEXT,
  last_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX webhook_subscriptions_owner ON webhook_subscriptions(owner_id,created_at);
-- event_id deliberately has no events FK: history pruning must not discard
-- an undelivered event or let its identity be enqueued again.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  event_id INTEGER, kind TEXT NOT NULL CHECK(kind IN ('run.stopped','control')),
  purpose TEXT CHECK(purpose IN ('activation','test')),
  request_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
  leased_until INTEGER, lease_id TEXT, dispatch_started_at INTEGER,
  delivered_at INTEGER, last_status INTEGER, last_error TEXT,
  outcome TEXT NOT NULL DEFAULT 'unattempted', exhausted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(subscription_id,event_id), UNIQUE(subscription_id,request_id)
);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries(available_at,leased_until)
  WHERE delivered_at IS NULL AND exhausted=0;
CREATE TABLE webhook_requests (
  owner_id TEXT NOT NULL, request_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
  action TEXT NOT NULL, digest TEXT NOT NULL, result_id TEXT,
  PRIMARY KEY(owner_id,request_id),
  FOREIGN KEY(subscription_id) REFERENCES webhook_subscriptions(id)
);
