import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Queries for the experiment_vms table (docs/architecture.md#recipe-add-or-extend-a-sql-table-module).
// state is written only through setState, called by transitionVm() in
// vm/machine.ts (docs/state-machines.md#experiment_vmsstate).

const parse = (row: unknown) =>
  parseRecord(QueryRecords.experiment_vms, row, "experiment_vms");

const insertStatement = statement(
  "INSERT INTO experiment_vms(id,owner_id,folder_id,provider,remote_name,state,auto_approve_local,vcpu_limit,memory_limit_gib,disk_limit_gib,auto_sleep_seconds,source_experiment_id,source_checkpoint_id,clone_url,last_active_at,created_at) SELECT ?,?,?,?,?,'provisioning',?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM folders WHERE id=? AND owner_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM experiment_vms WHERE id=? AND owner_id=?))",
);
/** Inserts the owner's experiment. Returns false, writing nothing, when the
 * folder or the source experiment is not the owner's. */
export function insert(
  db: Database.Database,
  vm: {
    id: string;
    owner: string;
    folderId: string;
    provider: string;
    remoteName: string;
    autoApproveLocal: boolean;
    vcpuLimit: number;
    memoryLimitGib: number;
    diskLimitGib: number;
    autoSleepSeconds: number;
    sourceExperimentId: string | null;
    sourceCheckpointId: string | null;
    cloneUrl: string | null;
    now: number;
  },
) {
  return (
    insertStatement(db).run(
      vm.id,
      vm.owner,
      vm.folderId,
      vm.provider,
      vm.remoteName,
      vm.autoApproveLocal ? 1 : 0,
      vm.vcpuLimit,
      vm.memoryLimitGib,
      vm.diskLimitGib,
      vm.autoSleepSeconds,
      vm.sourceExperimentId,
      vm.sourceCheckpointId,
      vm.cloneUrl,
      vm.now,
      vm.now,
      vm.folderId,
      vm.owner,
      vm.sourceExperimentId,
      vm.sourceExperimentId,
      vm.owner,
    ).changes === 1
  );
}

const byIdStatement = statement(
  "SELECT * FROM experiment_vms WHERE owner_id=? AND id=?",
);
export function byId(db: Database.Database, owner: string, id: string) {
  const row = byIdStatement(db).get(owner, id);
  return row === undefined ? undefined : parse(row);
}

const byFolderStatement = statement(
  "SELECT * FROM experiment_vms WHERE owner_id=? AND folder_id=?",
);
export function byFolder(db: Database.Database, owner: string, folder: string) {
  const row = byFolderStatement(db).get(owner, folder);
  return row === undefined ? undefined : parse(row);
}

const ownedStatement = statement(
  "SELECT * FROM experiment_vms WHERE owner_id=? ORDER BY created_at DESC, id",
);
export function owned(db: Database.Database, owner: string) {
  return ownedStatement(db).all(owner).map(parse);
}

const setStateStatement = statement(
  "UPDATE experiment_vms SET state=?,last_error=?,destroyed_at=CASE WHEN ?='destroyed' THEN ? ELSE destroyed_at END WHERE owner_id=? AND id=? AND state=?",
);
/** Moves `from` to `to`; returns false when the row is no longer in `from`. */
export function setState(
  db: Database.Database,
  owner: string,
  id: string,
  from: string,
  to: string,
  lastError: string | null,
  now: number,
) {
  return (
    setStateStatement(db).run(to, lastError, to, now, owner, id, from)
      .changes === 1
  );
}

const adoptRemoteStatement = statement(
  "UPDATE experiment_vms SET remote_id=? WHERE owner_id=? AND id=? AND (remote_id IS NULL OR remote_id=?)",
);
/** Records the provider's id once; a different id for the same VM is refused. */
export function adoptRemote(
  db: Database.Database,
  owner: string,
  id: string,
  remoteId: string,
) {
  return (
    adoptRemoteStatement(db).run(remoteId, owner, id, remoteId).changes === 1
  );
}

const touchStatement = statement(
  "UPDATE experiment_vms SET last_active_at=? WHERE owner_id=? AND id=?",
);
export function touch(
  db: Database.Database,
  owner: string,
  id: string,
  now: number,
) {
  touchStatement(db).run(now, owner, id);
}
