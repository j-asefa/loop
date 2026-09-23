CREATE TABLE workflow_steps(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,step_id TEXT NOT NULL,position INTEGER NOT NULL,state TEXT NOT NULL,child_run_id TEXT REFERENCES runs(id),approval_id TEXT REFERENCES approvals(id),output TEXT,artifact_id TEXT REFERENCES artifacts(id),PRIMARY KEY(run_id,step_id));
CREATE INDEX workflow_children ON workflow_steps(child_run_id);
INSERT INTO schema_version VALUES(4,unixepoch()*1000);
