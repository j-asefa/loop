-- Public assistant updates are messages. Preserve legacy IDs and ordering
-- cursors, but remove all transcript foreign keys and triggers on traces.
DROP TRIGGER transcript_trace_insert;
DROP TRIGGER transcript_trace_update;
DROP TRIGGER transcript_run_update;
DROP TRIGGER transcript_message_insert;
DROP TRIGGER transcript_message_update;
DROP TRIGGER transcript_message_delete;
DROP VIEW transcript_trace_entries;
DROP VIEW transcript_message_entries;
DROP TABLE conversation_transcript;

ALTER TABLE messages ADD COLUMN update_key TEXT;
ALTER TABLE messages ADD COLUMN transcript_ordinal INTEGER;
CREATE UNIQUE INDEX messages_update_key ON messages(owner_id,run_id,update_key);
CREATE INDEX messages_context ON messages(owner_id,run_id)
WHERE json_extract(metadata,'$.progress') IS NOT 1;
CREATE INDEX messages_final_update ON messages(owner_id,run_id)
WHERE update_key IS NOT NULL AND json_extract(metadata,'$.final')=1;

-- Display updates must not become duplicate result-search or model-memory entries.
DROP TRIGGER message_search_insert;
DROP TRIGGER message_search_update;
CREATE TRIGGER message_search_insert AFTER INSERT ON messages
WHEN json_extract(new.metadata,'$.progress') IS NOT 1 BEGIN
  INSERT INTO search_documents SELECT 'message:'||new.id,new.owner_id,'message',substr(new.content,1,90),new.content,c.agent_id,new.conversation_id,NULL,new.created_at,new.created_at FROM conversations c WHERE c.id=new.conversation_id;
END;
CREATE TRIGGER message_search_update AFTER UPDATE OF content ON messages
WHEN json_extract(new.metadata,'$.progress') IS NOT 1 BEGIN
  UPDATE search_documents SET content=new.content,title=substr(new.content,1,90),updated_at=unixepoch()*1000 WHERE id='message:'||new.id;
  DELETE FROM embeddings WHERE document_id='message:'||new.id;
END;

-- Final updates remain hidden message records so streamed identities can be
-- reconciled after reconnect, without looking up their former trace.
INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at,update_key,transcript_ordinal)
SELECT 'trace:'||t.id,t.owner_id,r.conversation_id,t.run_id,'assistant',t.content,
  json_set(t.metadata,'$.progress',json('true')),t.created_at,t.trace_key,t.id*2+1
FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=t.owner_id
WHERE t.kind='message';
INSERT INTO transcript_message_sequences(message_id)
SELECT id FROM messages WHERE update_key IS NOT NULL ORDER BY transcript_ordinal;

CREATE TABLE conversation_transcript(
  ordinal INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id TEXT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER,
  phase INTEGER NOT NULL
);
CREATE INDEX conversation_transcript_page
ON conversation_transcript(owner_id,conversation_id,position DESC,phase DESC,ordinal DESC);
CREATE INDEX conversation_transcript_run ON conversation_transcript(owner_id,run_id);

CREATE VIEW transcript_message_entries AS
SELECT COALESCE(m.transcript_ordinal,s.sequence*2) ordinal,m.owner_id,m.conversation_id,m.run_id,m.id message_id,
  COALESCE((SELECT min(p.sequence) FROM messages prompt
    JOIN transcript_message_sequences p ON p.message_id=prompt.id
    WHERE prompt.owner_id=m.owner_id AND prompt.run_id=m.run_id AND prompt.role='user'),
    CASE WHEN json_extract(m.metadata,'$.progress')=1 THEN
      (SELECT min(p.sequence) FROM messages entry JOIN transcript_message_sequences p ON p.message_id=entry.id
       WHERE entry.owner_id=m.owner_id AND entry.run_id=m.run_id
       AND json_extract(entry.metadata,'$.progress') IS NOT 1) END,s.sequence) position,
  CASE WHEN json_extract(m.metadata,'$.progress')=1 THEN m.created_at
    WHEN m.role='assistant' THEN 9007199254740991
    WHEN json_extract(m.metadata,'$.steeringId') IS NOT NULL THEN m.created_at ELSE 0 END phase,
  CASE WHEN json_extract(m.metadata,'$.progress')=1 THEN
    json_extract(m.metadata,'$.final') IS NOT 1 AND length(trim(m.content))>0
  ELSE m.role IN ('user','assistant','system') OR
    (m.role='tool' AND json_extract(m.metadata,'$.native.type') IN
      ('error','loop-delivery-unknown','loop-interrupted')) END visible
FROM messages m JOIN transcript_message_sequences s ON s.message_id=m.id;

INSERT INTO conversation_transcript
SELECT ordinal,owner_id,conversation_id,run_id,message_id,position,phase
FROM transcript_message_entries WHERE visible;
CREATE TRIGGER transcript_message_insert AFTER INSERT ON messages BEGIN
  INSERT INTO transcript_message_sequences(message_id) VALUES(NEW.id);
  INSERT INTO conversation_transcript
  SELECT ordinal,owner_id,conversation_id,run_id,message_id,position,phase
  FROM transcript_message_entries WHERE message_id=NEW.id AND visible;
  UPDATE conversation_transcript SET position=(
    SELECT e.position FROM transcript_message_entries e WHERE e.message_id=conversation_transcript.message_id)
  WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id
    AND json_extract(NEW.metadata,'$.progress') IS NOT 1;
END;
CREATE TRIGGER transcript_message_update
AFTER UPDATE OF owner_id,conversation_id,run_id,role,content,metadata,created_at ON messages BEGIN
  DELETE FROM conversation_transcript WHERE message_id=NEW.id;
  INSERT INTO conversation_transcript
  SELECT ordinal,owner_id,conversation_id,run_id,message_id,position,phase
  FROM transcript_message_entries WHERE message_id=NEW.id AND visible;
END;
CREATE TRIGGER transcript_message_move
AFTER UPDATE OF owner_id,conversation_id,run_id,role ON messages BEGIN
  UPDATE conversation_transcript SET position=(
    SELECT e.position FROM transcript_message_entries e WHERE e.message_id=conversation_transcript.message_id)
  WHERE owner_id=OLD.owner_id AND run_id=OLD.run_id;
  UPDATE conversation_transcript SET position=(
    SELECT e.position FROM transcript_message_entries e WHERE e.message_id=conversation_transcript.message_id)
  WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id;
END;
CREATE TRIGGER transcript_message_delete AFTER DELETE ON messages BEGIN
  UPDATE conversation_transcript SET position=(
    SELECT e.position FROM transcript_message_entries e WHERE e.message_id=conversation_transcript.message_id)
  WHERE owner_id=OLD.owner_id AND run_id=OLD.run_id
    AND json_extract(OLD.metadata,'$.progress') IS NOT 1;
END;
CREATE TRIGGER transcript_run_update AFTER UPDATE OF owner_id,conversation_id ON runs BEGIN
  UPDATE messages SET conversation_id=NEW.conversation_id
  WHERE owner_id=NEW.owner_id AND run_id=NEW.id AND update_key IS NOT NULL
    AND NEW.conversation_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND owner_id=NEW.owner_id);
END;
INSERT INTO schema_version VALUES(73,unixepoch()*1000);
