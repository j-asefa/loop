-- Keep memberships available to already-running delegations after a team is
-- removed from the workspace. Agents and history are independent of this flag.
ALTER TABLE teams ADD COLUMN deleted_at INTEGER;
INSERT INTO schema_version VALUES(24,unixepoch()*1000);
