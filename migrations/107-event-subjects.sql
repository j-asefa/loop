-- Connection changes have no run. Preserve run cascades and owner cursors
-- while introducing the two subjects needed by the shared run subscription.
CREATE TABLE events_next(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'run' CHECK(subject_kind IN ('run','connection')),
  subject_id TEXT,
  CHECK(
    (subject_kind='run' AND run_id IS NOT NULL AND (subject_id IS NULL OR subject_id=run_id))
    OR (subject_kind='connection' AND run_id IS NULL AND subject_id IS NOT NULL)
  )
);
INSERT INTO events_next(id,owner_id,run_id,type,payload,created_at,subject_kind,subject_id)
SELECT id,owner_id,run_id,type,payload,created_at,'run',run_id FROM events;

-- Copying surviving rows alone can reuse IDs above the surviving maximum.
INSERT INTO sqlite_sequence(name,seq)
SELECT 'events_next',seq FROM sqlite_sequence
WHERE name='events' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='events_next');
UPDATE sqlite_sequence SET seq=max(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0))
WHERE name='events_next';

DROP TABLE events;
ALTER TABLE events_next RENAME TO events;
CREATE INDEX event_cursor ON events(owner_id,id);
CREATE INDEX events_run ON events(run_id,id);

-- Older writers and fixtures still name the original columns explicitly.
-- Fill their run subject inside the same INSERT transaction. Connection
-- writers must supply a subject and never borrow an unrelated run identity.
CREATE TRIGGER events_run_subject AFTER INSERT ON events
WHEN NEW.subject_kind='run' AND NEW.subject_id IS NULL
BEGIN
  UPDATE events SET subject_id=NEW.run_id WHERE id=NEW.id;
END;

INSERT INTO schema_version(version,applied_at) VALUES(107,unixepoch()*1000);
