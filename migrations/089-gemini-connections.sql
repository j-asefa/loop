-- Expand the provider CHECK for existing unified databases as well as fresh ones.
-- Preserve all inbound references while rebuilding with foreign keys ON.
CREATE TEMP TABLE gemini_agent_connections AS SELECT id,connection_id FROM agents WHERE connection_id IS NOT NULL;
CREATE TEMP TABLE gemini_embedding_connections AS SELECT owner_id,embedding_connection FROM preferences WHERE embedding_connection IS NOT NULL;
CREATE TEMP TABLE gemini_brief_connections AS SELECT owner_id,project_id,connection_id FROM brief_state WHERE connection_id IS NOT NULL;
UPDATE brief_state SET connection_id=NULL WHERE connection_id IS NOT NULL;
UPDATE agents SET connection_id=NULL WHERE connection_id IS NOT NULL;
UPDATE preferences SET embedding_connection=NULL WHERE embedding_connection IS NOT NULL;
CREATE TABLE connections_gemini(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','codex','pi','opencode','acp','gemini')), label TEXT NOT NULL, secret TEXT NOT NULL, status TEXT NOT NULL, models TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
INSERT INTO connections_gemini SELECT * FROM connections;
DROP TABLE connections;
ALTER TABLE connections_gemini RENAME TO connections;
UPDATE agents SET connection_id=(SELECT connection_id FROM gemini_agent_connections WHERE id=agents.id) WHERE id IN (SELECT id FROM gemini_agent_connections);
UPDATE preferences SET embedding_connection=(SELECT embedding_connection FROM gemini_embedding_connections WHERE owner_id=preferences.owner_id) WHERE owner_id IN (SELECT owner_id FROM gemini_embedding_connections);
UPDATE brief_state SET connection_id=(SELECT connection_id FROM gemini_brief_connections b WHERE b.owner_id=brief_state.owner_id AND b.project_id=brief_state.project_id) WHERE EXISTS(SELECT 1 FROM gemini_brief_connections b WHERE b.owner_id=brief_state.owner_id AND b.project_id=brief_state.project_id);
DROP TABLE gemini_brief_connections;
DROP TABLE gemini_agent_connections;
DROP TABLE gemini_embedding_connections;
INSERT INTO schema_version VALUES(89,unixepoch()*1000);
