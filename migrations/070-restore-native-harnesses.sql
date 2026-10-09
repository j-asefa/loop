-- Restore only connections explicitly retired by 067. Account verification,
-- not this migration, reconnects them. Preserve IDs, native bindings and receipts.
UPDATE connections SET status='needs_sign_in',
  metadata=json_set(metadata,'$.nativeRecoveryRequired',json('true'))
WHERE status='disconnected' AND json_extract(metadata,'$.retiredDirectRuntime')=1
  AND json_extract(metadata,'$.backend') IS NOT 'hapi';
-- HAPI is no longer executable. Retain its history and uncertain receipts.
UPDATE connections SET status='disconnected'
WHERE json_extract(metadata,'$.backend')='hapi';
INSERT INTO schema_version VALUES(70,unixepoch()*1000);
