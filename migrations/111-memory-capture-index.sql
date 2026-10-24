-- Keep source lookups bounded for existing workers during an upgrade too.
-- The owner-qualified query uses the existing (owner_id,kind,source_id) key;
-- earlier workers omit owner_id and otherwise scan the complete source table.
-- This additive index can be installed before draining active agent runs.
CREATE INDEX IF NOT EXISTS memory_sources_capture ON memory_sources(kind,source_id,owner_id);
INSERT INTO schema_version VALUES(111,unixepoch()*1000);
