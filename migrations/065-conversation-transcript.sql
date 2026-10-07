-- A display-only ordering projection. Native/model context stays in its harness.
-- Explicit, monotonic message sequences preserve existing rowid-based cursors
-- through VACUUM and deletion of the last message; new messages never reuse one.
CREATE TABLE transcript_message_sequences(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO transcript_message_sequences(sequence,message_id)
SELECT rowid,id FROM messages ORDER BY rowid;

CREATE TABLE conversation_transcript(
  ordinal INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id TEXT,
  message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  trace_id INTEGER UNIQUE REFERENCES run_traces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER,
  phase INTEGER NOT NULL,
  CHECK((message_id IS NULL) <> (trace_id IS NULL))
);
CREATE INDEX conversation_transcript_page
ON conversation_transcript(owner_id,conversation_id,position DESC,phase DESC,ordinal DESC);
CREATE INDEX conversation_transcript_run ON conversation_transcript(owner_id,run_id);

-- Keep transcript eligibility and order in one place for backfill and writers.
-- The message view also supplies positions for links to hidden native rows.
CREATE VIEW transcript_message_entries AS
SELECT s.sequence*2 ordinal,m.owner_id,m.conversation_id,m.run_id,m.id message_id,
  NULL trace_id,
  COALESCE((SELECT min(p.sequence) FROM messages prompt
    JOIN transcript_message_sequences p ON p.message_id=prompt.id
    WHERE prompt.owner_id=m.owner_id AND prompt.run_id=m.run_id AND prompt.role='user'),s.sequence) position,
  CASE WHEN m.role='assistant' THEN 9007199254740991
    WHEN json_extract(m.metadata,'$.steeringId') IS NOT NULL THEN m.created_at ELSE 0 END phase,
  m.role IN ('user','assistant','system') OR
    (m.role='tool' AND json_extract(m.metadata,'$.native.type') IN
      ('error','loop-delivery-unknown','loop-interrupted')) visible
FROM messages m JOIN transcript_message_sequences s ON s.message_id=m.id;

CREATE VIEW transcript_trace_entries AS
SELECT t.id*2+1 ordinal,t.owner_id,r.conversation_id,t.run_id,NULL message_id,t.id trace_id,
  COALESCE((SELECT min(p.sequence) FROM messages prompt
    JOIN transcript_message_sequences p ON p.message_id=prompt.id
    WHERE prompt.owner_id=t.owner_id AND prompt.run_id=t.run_id AND prompt.role='user'),
  -- Imported and replayed runs can hold an answer with no prompt row. Their
  -- progress keeps the position of the run's first entry, as before this
  -- projection, so saved links to those traces still open their page.
  (SELECT min(p.sequence) FROM messages entry
    JOIN transcript_message_sequences p ON p.message_id=entry.id
    WHERE entry.owner_id=t.owner_id AND entry.run_id=t.run_id)) position,
  t.created_at phase
FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
WHERE r.conversation_id IS NOT NULL AND t.kind='message'
  AND json_extract(t.metadata,'$.final') IS NOT 1 AND length(trim(t.content))>0;

INSERT INTO conversation_transcript
SELECT ordinal,owner_id,conversation_id,run_id,message_id,trace_id,position,phase
FROM transcript_message_entries WHERE visible;
INSERT INTO conversation_transcript SELECT * FROM transcript_trace_entries;

CREATE TRIGGER transcript_message_insert AFTER INSERT ON messages BEGIN
  INSERT INTO transcript_message_sequences(message_id) VALUES(NEW.id);
  INSERT INTO conversation_transcript
  SELECT ordinal,owner_id,conversation_id,run_id,message_id,trace_id,position,phase
  FROM transcript_message_entries WHERE message_id=NEW.id AND visible;
  -- Native replay can import an answer or progress before its first prompt,
  -- and a run may never store one, so any role can establish these positions.
  UPDATE conversation_transcript SET position=COALESCE(
    (SELECT min(p.sequence) FROM messages prompt
      JOIN transcript_message_sequences p ON p.message_id=prompt.id
      WHERE prompt.owner_id=conversation_transcript.owner_id
        AND prompt.run_id=conversation_transcript.run_id AND prompt.role='user'),
    CASE WHEN message_id IS NOT NULL THEN ordinal/2 ELSE
      (SELECT min(p.sequence) FROM messages entry
        JOIN transcript_message_sequences p ON p.message_id=entry.id
        WHERE entry.owner_id=conversation_transcript.owner_id
          AND entry.run_id=conversation_transcript.run_id) END)
  WHERE owner_id=NEW.owner_id AND run_id=NEW.run_id;
END;

CREATE TRIGGER transcript_message_update
AFTER UPDATE OF owner_id,conversation_id,run_id,role,metadata,created_at ON messages BEGIN
  DELETE FROM conversation_transcript WHERE message_id=NEW.id;
  INSERT INTO conversation_transcript
  SELECT ordinal,owner_id,conversation_id,run_id,message_id,trace_id,position,phase
  FROM transcript_message_entries WHERE message_id=NEW.id AND visible;
  UPDATE conversation_transcript SET position=COALESCE(
    (SELECT min(p.sequence) FROM messages prompt
      JOIN transcript_message_sequences p ON p.message_id=prompt.id
      WHERE prompt.owner_id=conversation_transcript.owner_id
        AND prompt.run_id=conversation_transcript.run_id AND prompt.role='user'),
    CASE WHEN message_id IS NOT NULL THEN ordinal/2 ELSE
      (SELECT min(p.sequence) FROM messages entry
        JOIN transcript_message_sequences p ON p.message_id=entry.id
        WHERE entry.owner_id=conversation_transcript.owner_id
          AND entry.run_id=conversation_transcript.run_id) END)
  WHERE (owner_id=OLD.owner_id AND run_id=OLD.run_id) OR
    (owner_id=NEW.owner_id AND run_id=NEW.run_id);
END;

CREATE TRIGGER transcript_message_delete AFTER DELETE ON messages BEGIN
  UPDATE conversation_transcript SET position=COALESCE(
    (SELECT min(p.sequence) FROM messages prompt
      JOIN transcript_message_sequences p ON p.message_id=prompt.id
      WHERE prompt.owner_id=conversation_transcript.owner_id
        AND prompt.run_id=conversation_transcript.run_id AND prompt.role='user'),
    CASE WHEN message_id IS NOT NULL THEN ordinal/2 ELSE
      (SELECT min(p.sequence) FROM messages entry
        JOIN transcript_message_sequences p ON p.message_id=entry.id
        WHERE entry.owner_id=conversation_transcript.owner_id
          AND entry.run_id=conversation_transcript.run_id) END)
  WHERE owner_id=OLD.owner_id AND run_id=OLD.run_id;
END;

CREATE TRIGGER transcript_trace_insert AFTER INSERT ON run_traces BEGIN
  INSERT INTO conversation_transcript SELECT * FROM transcript_trace_entries WHERE trace_id=NEW.id;
END;
CREATE TRIGGER transcript_trace_update
AFTER UPDATE OF id,owner_id,run_id,kind,content,metadata,created_at ON run_traces BEGIN
  DELETE FROM conversation_transcript WHERE trace_id=NEW.id;
  INSERT INTO conversation_transcript SELECT * FROM transcript_trace_entries WHERE trace_id=NEW.id;
END;
CREATE TRIGGER transcript_run_update AFTER UPDATE OF owner_id,conversation_id ON runs BEGIN
  DELETE FROM conversation_transcript WHERE run_id=NEW.id AND trace_id IS NOT NULL;
  INSERT INTO conversation_transcript SELECT * FROM transcript_trace_entries WHERE run_id=NEW.id;
END;

-- Final-answer metadata is hydrated only for the page, with a bounded lookup
-- even when one run has thousands of tool traces.
CREATE INDEX run_traces_final_message ON run_traces(owner_id,run_id,id DESC)
WHERE kind='message' AND json_extract(metadata,'$.final')=1;

-- Recent activity snapshots and scoped file reviews do not walk tool history.
CREATE INDEX agent_activities_kind ON agent_activities(owner_id,scope,kind,sequence);
CREATE INDEX agent_activities_files ON agent_activities(owner_id,scope,run_id,kind,sequence);
-- Bound duplicate probes while paging legacy tools represented by durable records.
CREATE INDEX agent_activities_trace
ON agent_activities(owner_id,scope,run_id,json_extract(record,'$.data.links.trace'))
WHERE json_extract(record,'$.data.links.trace') IS NOT NULL;
INSERT INTO schema_version VALUES(65,unixepoch()*1000);
