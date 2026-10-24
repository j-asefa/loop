-- Usage is polled when opening a conversation. Keep unrelated trace payloads
-- out of that ordered lookup, while retaining the full event history.
CREATE INDEX events_usage ON events(owner_id,run_id,id)
WHERE type IN ('provider.receipt','native.usage');
ANALYZE events_usage;
INSERT INTO schema_version VALUES(114,unixepoch()*1000);
