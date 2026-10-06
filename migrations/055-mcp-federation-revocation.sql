ALTER TABLE mcp_federation_peers ADD COLUMN revoke_synced_at INTEGER;
INSERT INTO schema_version VALUES(55,unixepoch()*1000);
