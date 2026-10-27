-- Source dispatch state is separate from the authority's durable writer fence.
-- Unknown outcomes retain the exact proposal and can only query its receipt.
CREATE TABLE fleet_handoff_instances (
  owner_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL
);
CREATE TABLE fleet_handoff_jobs (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  proposal TEXT NOT NULL,
  directory_digest TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','uncertain','complete','superseded')),
  attempt_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,operation_id)
);

-- A removed machine may retrieve only the signed chain ending at its removal.
-- Keep the predecessor's public key with that proof, independently of later
-- directory revisions and local grant replacement. No credential is retained.
CREATE TABLE fleet_removal_history (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fleet_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  parent_digest TEXT NOT NULL,
  PRIMARY KEY(owner_id,peer_id,digest),
  FOREIGN KEY(owner_id,digest) REFERENCES fleet_directory_history(owner_id,digest),
  FOREIGN KEY(owner_id,parent_digest) REFERENCES fleet_directory_history(owner_id,digest)
);
INSERT INTO fleet_removal_history
SELECT child.owner_id,json_extract(member.value,'$.machineId'),
       json_extract(member.value,'$.publicKey'),child.fleet_id,child.digest,parent.digest
FROM fleet_directory_history child
JOIN fleet_directory_history parent ON parent.owner_id=child.owner_id
  AND parent.digest=json_extract(child.signed,'$.document.parent')
  AND parent.fleet_id=child.fleet_id
JOIN json_each(parent.signed,'$.document.members') member
WHERE json_extract(child.signed,'$.document.kind')='revision'
  AND EXISTS(SELECT 1 FROM json_each(child.signed,'$.document.tombstones') tombstone
    WHERE tombstone.value=json_extract(member.value,'$.machineId'))
  AND NOT EXISTS(SELECT 1 FROM json_each(child.signed,'$.document.members') current
    WHERE json_extract(current.value,'$.machineId')=json_extract(member.value,'$.machineId'));
