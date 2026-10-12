CREATE TABLE brief_items(
  id TEXT PRIMARY KEY,                       -- 'st_', 'dec_', 'q_', 'un_' prefix + random
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('state','decision','question','unfinished')),
  text TEXT NOT NULL,                        -- <= 240
  why TEXT,                                  -- <= 240, decisions only
  status TEXT NOT NULL,                      -- state: active|retired; decision: active|superseded|reverted; question: open|answered|dropped; unfinished: open|done
  cites TEXT NOT NULL DEFAULT '[]',          -- JSON [{ref, quote?}]
  evidence TEXT,                             -- decisions: owner_message|owner_saved|approval|merge|applied
  decided_by TEXT,                           -- decisions: 'you' | agent id | handle
  decided_at INTEGER,
  supersedes TEXT REFERENCES brief_items(id),
  asked_by TEXT,                             -- questions: 'you' | agent id | handle
  answered_cite TEXT,                        -- questions: JSON {ref, quote?}
  thread_id TEXT,                            -- unfinished: conversation id
  next TEXT, blocker TEXT,                   -- unfinished, <= 200 each
  author TEXT NOT NULL CHECK(author IN ('model','owner')),
  pinned INTEGER NOT NULL DEFAULT 0,
  cite_stale INTEGER NOT NULL DEFAULT 0,
  first_version INTEGER NOT NULL,
  last_version INTEGER NOT NULL,
  owner_rev INTEGER NOT NULL DEFAULT 0,      -- bumps on every owner edit of this row
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX brief_items_project ON brief_items(owner_id, project_id, kind, status, last_version DESC);

CREATE TABLE project_briefs(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  view TEXT NOT NULL,                        -- JSON: the bounded selection (ids per section, headline, overflow, derived snapshot)
  basis_since INTEGER NOT NULL, basis_through INTEGER NOT NULL,
  unincorporated_before INTEGER,             -- seq; set by initial generation when history was skipped
  synth_at INTEGER NOT NULL,
  connection_id TEXT, model TEXT,
  built_on_version INTEGER NOT NULL, owner_edit_rev INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('published','discarded','failed')),
  error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,      -- 'brief:<project>:<basis_through>'
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, project_id, version)
);

CREATE TABLE brief_state(                    -- one row per project: the cursor and edit revision
  owner_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  goal TEXT,                                 -- <= 200, owner only
  current_version INTEGER NOT NULL DEFAULT 0,
  basis_through INTEGER NOT NULL DEFAULT 0,  -- advances even when no version is created
  owner_edit_rev INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER, last_run_at INTEGER, last_error TEXT,
  PRIMARY KEY(owner_id, project_id)
);

CREATE TABLE brief_acks(
  owner_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, project_id)
);

-- Delivery rows are rate-limit bookkeeping and are cleared on watch resume.
-- Preserve the event-to-message binding on the durable source message instead.
UPDATE messages AS m SET metadata=json_set(metadata,'$.brief_pr_refs',json((
  SELECT json_group_array(DISTINCT p.ref)
  FROM pr_watch_deliveries d JOIN pr_watches w ON w.id=d.watch_id
  JOIN project_changes p ON p.owner_id=m.owner_id AND p.kind='pr_update'
    AND p.at=d.created_at AND substr(p.ref,1,length(w.id)+1)=w.id||':'
  WHERE d.run_id=m.run_id AND w.owner_id=m.owner_id AND w.conversation_id=m.conversation_id
    AND w.id=json_extract(m.metadata,'$.automation.watchId')
))) WHERE m.role='user' AND json_extract(m.metadata,'$.automation.kind')='github_watch';

CREATE TRIGGER brief_pr_citation_recorded AFTER INSERT ON project_changes
WHEN new.kind='pr_update' BEGIN
  UPDATE messages SET metadata=json_set(metadata,'$.brief_pr_refs',
    json_insert(COALESCE(json_extract(metadata,'$.brief_pr_refs'),'[]'),'$[#]',new.ref))
  WHERE owner_id=new.owner_id AND role='user'
    AND run_id IN (
      SELECT d.run_id FROM pr_watch_deliveries d JOIN pr_watches w ON w.id=d.watch_id
      WHERE w.owner_id=new.owner_id AND d.created_at=new.at
        AND substr(new.ref,1,length(w.id)+1)=w.id||':'
    )
    AND json_extract(metadata,'$.automation.kind')='github_watch'
    AND NOT EXISTS(SELECT 1 FROM json_each(metadata,'$.brief_pr_refs') WHERE value=new.ref)
    AND EXISTS(
      SELECT 1 FROM pr_watch_deliveries d JOIN pr_watches w ON w.id=d.watch_id
      WHERE d.run_id=messages.run_id AND d.created_at=new.at
        AND w.owner_id=messages.owner_id AND w.conversation_id=messages.conversation_id
        AND w.id=json_extract(messages.metadata,'$.automation.watchId')
        AND substr(new.ref,1,length(w.id)+1)=w.id||':'
    );
END;

INSERT INTO schema_version VALUES(78,unixepoch()*1000);
