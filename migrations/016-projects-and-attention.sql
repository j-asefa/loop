ALTER TABLE agents ADD COLUMN folder_id TEXT REFERENCES folders(id);
ALTER TABLE runs ADD COLUMN attention_dismissed_at INTEGER;
CREATE INDEX agent_folder ON agents(owner_id,folder_id);
-- Recover project choices that were saved with an agent's initial task.
UPDATE agents SET folder_id=(
  SELECT f.id FROM agent_creations c JOIN runs r ON r.id=c.run_id
  JOIN folders f ON f.id=json_extract(r.payload,'$.folderId') AND f.owner_id=agents.owner_id
  WHERE c.agent_id=agents.id AND c.owner_id=agents.owner_id
  ORDER BY c.created_at LIMIT 1
);
INSERT INTO schema_version VALUES(16,unixepoch()*1000);
