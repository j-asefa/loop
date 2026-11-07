-- Shared memory uses the local FTS index, updated atomically by source triggers.
DROP TABLE memory_outbox;
ALTER TABLE memory_sources DROP COLUMN indexed_revision;
