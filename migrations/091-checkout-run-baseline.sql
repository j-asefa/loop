-- A complete binary patch of tracked changes at dispatch, relative to
-- start_head. NULL marks a historical source-checkout comparison; an empty
-- string is a clean run baseline. Keep old observations and citations intact.
ALTER TABLE run_checkouts ADD COLUMN start_patch TEXT;
ALTER TABLE run_checkouts ADD COLUMN start_untracked_paths TEXT;

INSERT INTO schema_version VALUES(91,unixepoch()*1000);
