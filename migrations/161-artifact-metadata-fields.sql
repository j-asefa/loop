-- D5: artifact metadata is one strict schema per role. Fields no current
-- producer writes and no reader consumes are removed from the stored rows so
-- the per-role arms can be strict: the artifact `partial` flag (D4 removed its
-- writers in 2b) and the legacy trace provenance fields. D7's exception covers
-- the backfill of these stored rows; nothing in the runtime tolerates them.
UPDATE artifacts SET metadata = json_remove(metadata,'$.partial')
  WHERE json_type(metadata,'$.partial') IS NOT NULL;
UPDATE artifacts SET metadata =
    json_remove(metadata,'$.backend','$.threadId','$.turnId')
  WHERE json_type(metadata,'$.backend') IS NOT NULL
    OR json_type(metadata,'$.threadId') IS NOT NULL
    OR json_type(metadata,'$.turnId') IS NOT NULL;