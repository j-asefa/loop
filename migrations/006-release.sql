CREATE TABLE worker_health(id TEXT PRIMARY KEY,heartbeat INTEGER NOT NULL);
CREATE TABLE request_limits(owner_id TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
INSERT INTO schema_version VALUES(6,unixepoch()*1000);
