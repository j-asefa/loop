-- Retire runnable direct connections without moving history, credentials or
-- dispatch identities to a different backend. Owners reconnect agents to HAPI
-- explicitly; queued legacy work is rejected at the dispatch boundary.
-- Flag every row this retires (not only connected ones) so a later restore can
-- tell retirement from an intentional disconnect.
UPDATE connections SET status='disconnected',
  metadata=CASE WHEN status<>'disconnected' THEN json_set(metadata,'$.retiredDirectRuntime',json('true')) ELSE metadata END
WHERE json_extract(metadata,'$.backend') IS NOT 'hapi'
  AND (json_extract(metadata,'$.loopHarness') IS NOT NULL
       OR json_extract(metadata,'$.authMode')='subscription');
INSERT INTO schema_version VALUES(67,unixepoch()*1000);
