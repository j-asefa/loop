-- Keep full answers on the existing harness delivery path; history stores a
-- bounded preview and explicitly identifies omitted response text.
ALTER TABLE personal_decisions ADD COLUMN response_truncated INTEGER NOT NULL DEFAULT 0
  CHECK(response_truncated IN (0,1));

INSERT INTO schema_version VALUES(117,unixepoch()*1000);
