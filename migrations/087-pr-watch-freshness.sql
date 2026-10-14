-- What a watch last saw and when it last read successfully, kept apart from
-- the last concluded checks: a rerun on the same head leaves the previous
-- conclusion in place, and a failed read, pause or resume touches updated_at
-- without reading anything.
ALTER TABLE pr_watches ADD COLUMN ci_pending INTEGER NOT NULL DEFAULT 0; -- checks for the current head had not all finished at the last read
ALTER TABLE pr_watches ADD COLUMN read_at INTEGER;                       -- last successful read of GitHub

INSERT INTO schema_version VALUES(87,unixepoch()*1000);
