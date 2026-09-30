CREATE INDEX IF NOT EXISTS personal_message_history ON messages(owner_id,created_at DESC,id DESC) WHERE role='user';
CREATE INDEX IF NOT EXISTS delegation_child_run ON delegations(child_run_id);
INSERT INTO schema_version VALUES(36,unixepoch()*1000);
