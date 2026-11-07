-- Pairing belongs to every companion, with or without the fleet extension.
ALTER TABLE fleet_devices RENAME TO devices;
ALTER TABLE fleet_device_store RENAME TO device_store;
ALTER TABLE fleet_pairing_ceremonies RENAME TO pairing_ceremonies;
ALTER TABLE fleet_pairing_clock RENAME TO pairing_clock;

-- Search reads the unified search_fts index.
DROP TRIGGER artifact_insert;
DROP TRIGGER artifact_delete;
DROP TRIGGER artifact_update;
DROP TABLE artifact_fts;

-- Unreachable HAPI execution and per-project Loop import state.
DROP TABLE native_dispatches;
DROP TABLE native_projection;
DROP TABLE native_permissions;
DROP TABLE native_sessions;
DROP TABLE environment_projects;
DROP TABLE execution_environments;
DROP TABLE pr_watch_registrations;
DROP TABLE search_vectors;
DROP TABLE legacy_imports;
DROP TRIGGER change_conversations_update;
ALTER TABLE conversations DROP COLUMN execution_backend;
CREATE TRIGGER change_conversations_update AFTER UPDATE ON conversations
WHEN NEW.owner_id IS NOT NULL AND (OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id OR OLD.feed_hidden IS NOT NEW.feed_hidden)
BEGIN
 INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
 SELECT NEW.owner_id,NULL,'conversation',NEW.id,'invalidate',json_object('scope',json_object('kind','collection','id','feed'),'scopes',json_array(json_object('kind','collection','id','later'),json_object('kind','collection','id','results'),json_object('kind','collection','id','saved'),json_object('kind','collection','id',CASE WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.title IS NOT NEW.title OR OLD.origin IS NOT NEW.origin OR OLD.external_id IS NOT NEW.external_id OR OLD.created_at IS NOT NEW.created_at OR OLD.team_id IS NOT NEW.team_id OR OLD.execution_connection_id IS NOT NEW.execution_connection_id OR OLD.project_id IS NOT NEW.project_id THEN 'metadata' ELSE 'feed' END),CASE WHEN NEW.id IS NOT NULL THEN json_object('kind','conversation','id',NEW.id) ELSE json_object('kind','collection','id','feed') END)),unixepoch('subsec')*1000;
END;

-- Both current binding writers supply an agent identity before insertion, so
-- only an earlier Loop build can have left a binding without one. Earlier
-- installations are unsupported (start with a fresh data directory); such a
-- binding is not copied rather than failing every startup, and its
-- conversation is not resumed natively.
CREATE TABLE current_companion_sessions(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), harness TEXT NOT NULL, native_id TEXT, project TEXT NOT NULL, model TEXT, instructions TEXT NOT NULL DEFAULT '', generation TEXT, state TEXT NOT NULL DEFAULT 'idle', last_run_id TEXT, updated_at INTEGER NOT NULL, effort TEXT, permission_mode TEXT, permission_base TEXT, worktree_source TEXT, worktree_agent_id TEXT NOT NULL, UNIQUE(harness,native_id));
INSERT INTO current_companion_sessions(conversation_id,harness,native_id,project,model,instructions,generation,state,last_run_id,updated_at,effort,permission_mode,permission_base,worktree_source,worktree_agent_id)
SELECT conversation_id,harness,native_id,project,model,instructions,generation,state,last_run_id,updated_at,effort,permission_mode,permission_base,worktree_source,worktree_agent_id FROM companion_sessions WHERE worktree_agent_id IS NOT NULL;
DROP TABLE companion_sessions;
ALTER TABLE current_companion_sessions RENAME TO companion_sessions;

-- Current Done readers use independent result identities and their sort order.
DROP INDEX feed_cards_legacy;
ALTER TABLE feed_cards DROP COLUMN legacy_sort_at;
ALTER TABLE feed_cards DROP COLUMN legacy_hidden;
