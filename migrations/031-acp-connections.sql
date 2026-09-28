-- Expand the provider CHECK for existing unified databases as well as fresh ones.
-- Preserve both inbound connection references while rebuilding with foreign keys ON.
CREATE TEMP TABLE acp_agent_connections AS SELECT id,connection_id FROM agents WHERE connection_id IS NOT NULL;
CREATE TEMP TABLE acp_embedding_connections AS SELECT owner_id,embedding_connection FROM preferences WHERE embedding_connection IS NOT NULL;
UPDATE agents SET connection_id=NULL WHERE connection_id IS NOT NULL;
UPDATE preferences SET embedding_connection=NULL WHERE embedding_connection IS NOT NULL;
CREATE TABLE connections_acp(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','codex','pi','opencode','acp')), label TEXT NOT NULL, secret TEXT NOT NULL, status TEXT NOT NULL, models TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
INSERT INTO connections_acp SELECT * FROM connections;
DROP TABLE connections;
ALTER TABLE connections_acp RENAME TO connections;
UPDATE agents SET connection_id=(SELECT connection_id FROM acp_agent_connections WHERE id=agents.id) WHERE id IN (SELECT id FROM acp_agent_connections);
UPDATE preferences SET embedding_connection=(SELECT embedding_connection FROM acp_embedding_connections WHERE owner_id=preferences.owner_id) WHERE owner_id IN (SELECT owner_id FROM acp_embedding_connections);
DROP TABLE acp_agent_connections;
DROP TABLE acp_embedding_connections;
INSERT INTO schema_version VALUES(31,unixepoch()*1000);
