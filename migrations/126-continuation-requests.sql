-- Keep the accepted request even if its queued prompt is edited or its thread
-- is removed. An uncertain retry must never create another continuation.
CREATE TABLE continuation_requests(
 owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request TEXT NOT NULL,
 conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,idempotency_key)
);
