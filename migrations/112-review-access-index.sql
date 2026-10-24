-- Identity and status checks must not fetch the repository snapshot, including
-- traversing overflow pages to reach columns stored after that large TEXT value.
CREATE INDEX code_reviews_access ON code_reviews(owner_id,id,fingerprint,team_id,folder_id,run_id,created_at,source_path);
INSERT INTO schema_version VALUES(112,unixepoch()*1000);
