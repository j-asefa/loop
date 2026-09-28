-- Shared agent activities (plans, tools, file changes, output, settings,
-- command catalogs and capabilities) for native, API-provider and ACP runs.
-- `record` is the reduced display record from src/agent-activities.ts; it is
-- never fed back to a model. Turn kinds belong to a run; session kinds
-- (settings, commands, capabilities) belong to the conversation.
CREATE TABLE agent_activities(
  owner_id TEXT NOT NULL,
  -- Conversation id, or 'run:'||run_id for runs without a conversation.
  scope TEXT NOT NULL,
  activity_key TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('plan','tool','file_change','output','settings','commands','capabilities')),
  record TEXT NOT NULL,
  -- Increases on every change within the owner; clients sync with ?after=.
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,scope,activity_key)
);
CREATE INDEX agent_activities_sequence ON agent_activities(owner_id,scope,sequence);
CREATE INDEX agent_activities_run ON agent_activities(run_id);
INSERT INTO schema_version VALUES(30,unixepoch()*1000);
