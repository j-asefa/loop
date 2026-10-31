-- Private staging is not an artifact, attachment, or model-context grant.
CREATE TABLE fleet_mail_files (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0 AND size <= 26214400),
  received INTEGER NOT NULL DEFAULT 0 CHECK(received >= 0 AND received <= size),
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,peer_id,message_id,file_id),
  FOREIGN KEY(owner_id,peer_id,message_id)
    REFERENCES fleet_mail_inbox(owner_id,peer_id,message_id) ON DELETE CASCADE
);
CREATE INDEX fleet_mail_files_expiry ON fleet_mail_files(expires_at);
CREATE TABLE fleet_mail_file_chunks (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  offset INTEGER NOT NULL CHECK(offset >= 0),
  bytes BLOB NOT NULL CHECK(length(bytes) <= 196608),
  PRIMARY KEY(owner_id,peer_id,message_id,file_id,offset),
  FOREIGN KEY(owner_id,peer_id,message_id,file_id)
    REFERENCES fleet_mail_files(owner_id,peer_id,message_id,file_id) ON DELETE CASCADE
);
