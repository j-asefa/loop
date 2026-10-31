-- Remote participants are explicit machine/agent references. They are not
-- inserted into agents and confer no local team or delegation membership.
CREATE TABLE fleet_mail_threads(
  thread_id TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  wire_thread_id TEXT NOT NULL,
  local_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  peer_id TEXT NOT NULL,
  remote_agent_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  local_grant_id TEXT NOT NULL,
  peer_grant_id TEXT NOT NULL,
  UNIQUE(owner_id,origin_id,wire_thread_id)
);
CREATE INDEX fleet_mail_threads_peer ON fleet_mail_threads(owner_id,peer_id);
