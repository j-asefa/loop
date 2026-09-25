ALTER TABLE runtime_hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'broker'
  CHECK(kind IN ('broker','codex-app-server','native-host'));
UPDATE runtime_hosts SET kind='codex-app-server' WHERE url LIKE 'ws://%' OR url LIKE 'wss://%';
INSERT INTO schema_version VALUES(12,unixepoch()*1000);
