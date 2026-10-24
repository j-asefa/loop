-- Personal responses are separate from request/execution state: automatic
-- approvals and expired, unanswered requests are not actions by the owner.
CREATE TABLE personal_decisions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  approval_id TEXT UNIQUE REFERENCES approvals(id) ON DELETE CASCADE,
  native_decision_id TEXT UNIQUE REFERENCES native_decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('approval','answer')),
  response TEXT,
  created_at INTEGER NOT NULL,
  CHECK((approval_id IS NOT NULL) <> (native_decision_id IS NOT NULL))
);
CREATE INDEX personal_decisions_owner_kind_time ON personal_decisions(owner_id,kind,created_at DESC,id DESC);
CREATE INDEX personal_decisions_run ON personal_decisions(run_id);

-- Recover only explicit decisions, never infer them from an approval's current
-- state (runs also close unanswered requests, and policies auto-approve calls).
INSERT INTO personal_decisions(id,owner_id,run_id,approval_id,kind,response,created_at)
SELECT 'approval:'||a.id,a.owner_id,a.run_id,a.id,'approval',
  json_object('choice',CASE WHEN e.type='failed' THEN 'reject' WHEN e.type='queued' THEN 'approve'
    ELSE json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.decision') END),min(e.created_at)
FROM events e JOIN approvals a ON a.id=json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.approvalId')
  AND a.owner_id=e.owner_id AND a.run_id=e.run_id
WHERE (e.type IN ('queued','failed') OR (e.type='approval.decided' AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.decision') IN ('approve','reject')))
  AND NOT EXISTS(SELECT 1 FROM events auto WHERE auto.owner_id=a.owner_id AND auto.run_id=a.run_id
    AND auto.type='approval.auto_approved' AND json_extract(CASE WHEN json_valid(auto.payload) THEN auto.payload ELSE '{}' END,'$.approvalId')=a.id)
GROUP BY a.id;

-- Native commands retained a digest, not the response. Keep that honest in the
-- profile; their request date is all that can be recovered reliably.
INSERT INTO personal_decisions(id,owner_id,run_id,native_decision_id,kind,response,created_at)
SELECT 'native:'||d.id,r.owner_id,r.id,d.id,
  CASE json_extract(d.request,'$.kind') WHEN 'approval' THEN 'approval' ELSE 'answer' END,NULL,d.created_at
FROM native_decisions d JOIN runs r ON r.id=d.run_id AND r.conversation_id=d.conversation_id
WHERE d.command_id IS NOT NULL AND d.command_id NOT LIKE 'auto:%'
  AND json_extract(d.request,'$.kind') IN ('approval','question');

-- History belongs to the existing approvals/decisions projections. Publish
-- with its write, including a surviving invalidation when a source cascades
-- away. The bus publishes only committed events, also across API/worker WAL
-- connections. Source-state changes already invalidate these same scopes.
CREATE TRIGGER change_personal_decisions_insert AFTER INSERT ON personal_decisions BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  VALUES(NEW.owner_id,NULL,'collection','decisions','invalidate',
    '{"scope":{"kind":"collection","id":"decisions"},"scopes":[{"kind":"collection","id":"approvals"}]}',unixepoch('subsec')*1000);
END;
CREATE TRIGGER change_personal_decisions_update AFTER UPDATE ON personal_decisions BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  SELECT owner_id,NULL,'collection','decisions','invalidate',
    '{"scope":{"kind":"collection","id":"decisions"},"scopes":[{"kind":"collection","id":"approvals"}]}',unixepoch('subsec')*1000
  FROM (SELECT OLD.owner_id owner_id UNION SELECT NEW.owner_id);
END;
CREATE TRIGGER change_personal_decisions_delete BEFORE DELETE ON personal_decisions BEGIN
  INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
  VALUES(OLD.owner_id,NULL,'collection','decisions','tombstone',
    '{"scope":{"kind":"collection","id":"decisions"},"scopes":[{"kind":"collection","id":"approvals"}],"removed":{"kind":"collection","id":"decisions"}}',unixepoch('subsec')*1000);
END;

INSERT INTO schema_version VALUES(116,unixepoch()*1000);
