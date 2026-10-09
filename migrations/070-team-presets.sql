ALTER TABLE teams ADD COLUMN preset_id TEXT;
ALTER TABLE teams ADD COLUMN preset_version INTEGER;
ALTER TABLE teams ADD COLUMN preset_config TEXT;
ALTER TABLE teams ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
CREATE TABLE team_creations (
  owner_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id), PRIMARY KEY(owner_id, request_key)
);
CREATE TABLE code_reviews (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  folder_id TEXT NOT NULL REFERENCES folders(id),
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id), created_at INTEGER NOT NULL,
  UNIQUE(owner_id, request_key)
);
CREATE INDEX code_reviews_run ON code_reviews(run_id);
-- Keep specialist reports in the team feed, but notify only for the lead's
-- consolidated result (including later explanations in the lead thread).
CREATE TRIGGER quiet_review_workers BEFORE INSERT ON push_deliveries
WHEN EXISTS (
  SELECT 1 FROM artifacts a JOIN code_reviews review
    ON review.id=json_extract(a.metadata,'$.reviewId') AND review.owner_id=a.owner_id
  JOIN runs lead ON lead.id=review.run_id
  WHERE a.id=new.artifact_id AND a.agent_id<>lead.agent_id
) BEGIN
  SELECT RAISE(IGNORE);
END;
INSERT INTO schema_version VALUES(70,unixepoch()*1000);
