-- A completed native command and its display cursor commit together with this
-- read-only verification intent. Retries never dispatch the native command.
CREATE TABLE IF NOT EXISTS pr_watch_registrations (
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 external_id TEXT NOT NULL,
 environment_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 repo_owner TEXT NOT NULL,
 repo_name TEXT NOT NULL,
 number INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id,external_id)
);
CREATE INDEX IF NOT EXISTS pr_watch_registrations_due ON pr_watch_registrations(next_attempt_at);
INSERT INTO schema_version VALUES(68,unixepoch()*1000);
