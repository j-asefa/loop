CREATE TABLE agent_mail_retries (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  mail_id TEXT REFERENCES agent_mail(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts>=0),
  retry_at INTEGER NOT NULL CHECK(typeof(retry_at)='integer'),
  delay_ms INTEGER NOT NULL CHECK(typeof(delay_ms)='integer' AND delay_ms BETWEEN 0 AND 300000),
  PRIMARY KEY(owner_id,key),
  CHECK((mail_id IS NULL) <> (run_id IS NULL))
);
CREATE INDEX agent_mail_retries_mail ON agent_mail_retries(mail_id);
CREATE INDEX agent_mail_retries_run ON agent_mail_retries(run_id);
