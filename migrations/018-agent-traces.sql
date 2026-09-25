CREATE TABLE run_traces(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  trace_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message','tool')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id,trace_key)
);
CREATE INDEX run_traces_owner_run ON run_traces(owner_id,run_id,id);

-- Preserve prior tool results in the trace timeline without moving/deleting files.
INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,metadata,artifact_id,created_at)
SELECT a.owner_id,a.run_id,'artifact:'||a.id,'tool',a.title,
  json_object('state','completed','tool',json_extract(a.metadata,'$.tool')),a.id,a.created_at
FROM artifacts a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
WHERE json_extract(a.metadata,'$.tool') IS NOT NULL OR json_extract(a.metadata,'$.native')=1;

-- A checkpoint includes earlier conversation messages. Only its final `round`
-- assistant entries belong to this run.
INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at)
SELECT owner_id,run_id,'turn:'||(position-(total-round)-1),'message',
  CASE WHEN json_array_length(json_extract(value,'$.toolCalls'))>0 THEN 'Agent update' ELSE 'Final answer' END,
  COALESCE(json_extract(value,'$.content'),''),
  json_object('final',CASE WHEN json_array_length(json_extract(value,'$.toolCalls'))>0 THEN json('false') ELSE json('true') END),created_at
FROM (
  SELECT r.owner_id,r.id run_id,c.round,j.value,r.created_at,
    row_number() OVER(PARTITION BY r.id ORDER BY CAST(j.key AS INTEGER)) position,
    count(*) OVER(PARTITION BY r.id) total
  FROM agent_checkpoints c JOIN runs r ON r.id=c.run_id, json_each(c.history) j
  WHERE json_extract(j.value,'$.role')='assistant'
) WHERE position>total-round;

-- Correct old concatenated answers only when they still match the generator's
-- saved output. User edits and artifact versions remain intact.
UPDATE messages SET content=(SELECT json_extract(c.history,'$[#-1].content') FROM agent_checkpoints c WHERE c.message_id=messages.id)
WHERE EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.message_id=messages.id AND c.stage='done' AND messages.content=c.output AND json_extract(c.history,'$[#-1].role')='assistant');
UPDATE artifacts SET content=(SELECT m.content FROM agent_checkpoints c JOIN messages m ON m.id=c.message_id WHERE c.artifact_id=artifacts.id)
WHERE EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.artifact_id=artifacts.id AND c.stage='done' AND artifacts.content=c.output)
  AND NOT EXISTS(SELECT 1 FROM artifact_versions v WHERE v.artifact_id=artifacts.id AND v.version>1);
UPDATE artifact_versions SET content=(SELECT m.content FROM agent_checkpoints c JOIN messages m ON m.id=c.message_id WHERE c.artifact_id=artifact_versions.artifact_id)
WHERE version=1 AND EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.artifact_id=artifact_versions.artifact_id AND c.stage='done' AND artifact_versions.content=c.output);
UPDATE runs SET result=(SELECT m.content FROM agent_checkpoints c JOIN messages m ON m.id=c.message_id WHERE c.run_id=runs.id)
WHERE EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=runs.id AND c.stage='done' AND runs.result=c.output);
UPDATE agent_checkpoints SET output=(SELECT content FROM messages WHERE id=message_id) WHERE stage='done';

-- Publish finished work at completion, so a long run appears at the top even
-- when its placeholder was created before the currently loaded feed page.
CREATE TABLE artifact_publications(sequence INTEGER PRIMARY KEY AUTOINCREMENT,artifact_id TEXT NOT NULL UNIQUE);
INSERT INTO artifact_publications(artifact_id)
SELECT a.id FROM artifacts a LEFT JOIN runs r ON r.id=a.run_id
WHERE a.run_id IS NULL OR r.state='completed'
ORDER BY COALESCE(r.updated_at,a.created_at),a.rowid;
CREATE TRIGGER artifact_publish AFTER INSERT ON artifacts
WHEN new.run_id IS NULL OR EXISTS(SELECT 1 FROM runs WHERE id=new.run_id AND state='completed') BEGIN
  INSERT OR IGNORE INTO artifact_publications(artifact_id) VALUES(new.id);
END;
CREATE TRIGGER run_publish AFTER UPDATE OF state ON runs
WHEN new.state='completed' AND old.state<>'completed' BEGIN
  INSERT OR IGNORE INTO artifact_publications(artifact_id) SELECT id FROM artifacts WHERE run_id=new.id ORDER BY rowid;
END;
INSERT INTO schema_version VALUES(18,unixepoch()*1000);
