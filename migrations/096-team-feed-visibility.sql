ALTER TABLE teams ADD COLUMN hide_results_from_feed INTEGER NOT NULL DEFAULT 0 CHECK(hide_results_from_feed IN (0,1));
INSERT INTO schema_version VALUES(96,unixepoch()*1000);
