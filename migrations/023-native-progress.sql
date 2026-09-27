-- Recover existing public progress messages from the native display projection.
-- Only a completed turn's last assistant item is its final answer. User edits
-- remain intact; the original native items are retained in full.
CREATE TEMP TABLE native_finals AS
SELECT n.run_id,n.native_id,json_extract(n.item,'$.text') content
FROM native_items n JOIN runs r ON r.id=n.run_id
WHERE r.state='completed' AND n.rowid=(
  SELECT max(last.rowid) FROM native_items last WHERE last.run_id=n.run_id
  AND json_extract(last.item,'$.kind')='assistant'
  AND json_extract(last.item,'$.phase') IS NOT 'commentary'
  AND length(trim(json_extract(last.item,'$.text')))>0
);

INSERT OR IGNORE INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at)
SELECT r.owner_id,n.run_id,'native-message:'||n.native_id,'message',
  CASE WHEN f.native_id=n.native_id THEN 'Final answer' ELSE 'Agent update' END,
  json_extract(n.item,'$.text'),
  json_object('native',json('true'),'itemId',n.native_id,'final',json(CASE WHEN f.native_id=n.native_id THEN 'true' ELSE 'false' END)),n.updated_at
FROM native_items n JOIN runs r ON r.id=n.run_id
LEFT JOIN native_finals f ON f.run_id=n.run_id
WHERE json_extract(n.item,'$.kind')='assistant' AND length(trim(json_extract(n.item,'$.text')))>0
ORDER BY n.rowid;

UPDATE messages SET content=(SELECT f.content FROM native_finals f WHERE f.run_id=messages.run_id)
WHERE EXISTS(SELECT 1 FROM agent_checkpoints c JOIN native_finals f ON f.run_id=c.run_id
  WHERE c.message_id=messages.id AND c.stage='done' AND messages.content=c.output);
UPDATE artifacts SET content=(SELECT f.content FROM native_finals f WHERE f.run_id=artifacts.run_id)
WHERE EXISTS(SELECT 1 FROM agent_checkpoints c JOIN native_finals f ON f.run_id=c.run_id
  WHERE c.artifact_id=artifacts.id AND c.stage='done' AND artifacts.content=c.output)
  AND NOT EXISTS(SELECT 1 FROM artifact_versions v WHERE v.artifact_id=artifacts.id AND v.version>1);
UPDATE artifact_versions SET content=(SELECT f.content FROM agent_checkpoints c JOIN native_finals f ON f.run_id=c.run_id WHERE c.artifact_id=artifact_versions.artifact_id)
WHERE version=1 AND EXISTS(SELECT 1 FROM agent_checkpoints c JOIN native_finals f ON f.run_id=c.run_id
  WHERE c.artifact_id=artifact_versions.artifact_id AND c.stage='done' AND artifact_versions.content=c.output);
UPDATE runs SET result=(SELECT f.content FROM native_finals f WHERE f.run_id=runs.id)
WHERE EXISTS(SELECT 1 FROM agent_checkpoints c JOIN native_finals f ON f.run_id=c.run_id
  WHERE c.run_id=runs.id AND c.stage='done' AND runs.result=c.output);
UPDATE agent_checkpoints SET output=(SELECT content FROM native_finals WHERE run_id=agent_checkpoints.run_id)
WHERE stage='done' AND run_id IN (SELECT run_id FROM native_finals);
DROP TABLE native_finals;
INSERT INTO schema_version VALUES(23,unixepoch()*1000);
