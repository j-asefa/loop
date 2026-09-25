ALTER TABLE artifacts ADD COLUMN feed_hidden INTEGER NOT NULL DEFAULT 0;
CREATE TABLE teams(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,manager_id TEXT NOT NULL REFERENCES agents(id),conversation_id TEXT REFERENCES conversations(id),created_at INTEGER NOT NULL);
CREATE TABLE team_members(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,agent_id TEXT NOT NULL REFERENCES agents(id),PRIMARY KEY(team_id,agent_id));
ALTER TABLE conversations ADD COLUMN team_id TEXT REFERENCES teams(id);
CREATE INDEX conversation_team ON conversations(owner_id,team_id);
CREATE TABLE delegations(parent_run_id TEXT NOT NULL REFERENCES runs(id),call_id TEXT NOT NULL,child_run_id TEXT NOT NULL REFERENCES runs(id),arguments TEXT NOT NULL,PRIMARY KEY(parent_run_id,call_id));
CREATE TABLE native_calls(run_id TEXT NOT NULL REFERENCES runs(id),call_id TEXT NOT NULL,tool TEXT NOT NULL,arguments TEXT NOT NULL,approval_id TEXT REFERENCES approvals(id),result TEXT,artifact_id TEXT REFERENCES artifacts(id),PRIMARY KEY(run_id,call_id));
CREATE TABLE runtime_hosts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,created_at INTEGER NOT NULL);
INSERT INTO schema_version VALUES(10,unixepoch()*1000);
