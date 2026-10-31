-- Bodies remain on the sending machine until their immutable destination has
-- settled. Inbox identities survive payload/queue cleanup and never replay work.
CREATE TABLE fleet_mail_outbox (
  owner_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  source_grant_id TEXT NOT NULL,
  destination_grant_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  envelope TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','unknown','accepted','refused')),
  local_refusal TEXT,
  receipt TEXT,
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
  transmitted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,message_id)
);
CREATE INDEX fleet_mail_outbox_pending ON fleet_mail_outbox(owner_id,settled,created_at);
CREATE TABLE fleet_mail_inbox (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  source_grant_id TEXT NOT NULL,
  destination_grant_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  admission TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  settled INTEGER NOT NULL CHECK(settled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,peer_id,message_id)
);
CREATE INDEX fleet_mail_inbox_pending ON fleet_mail_inbox(owner_id,settled,created_at);
