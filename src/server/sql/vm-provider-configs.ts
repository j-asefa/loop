import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Queries for the vm_provider_configs table (docs/architecture.md#recipe-add-or-extend-a-sql-table-module).
// encrypted_api_key is sealed by the caller; this module never sees the key.

const byOwnerStatement = statement(
  "SELECT * FROM vm_provider_configs WHERE owner_id=?",
);
export function byOwner(db: Database.Database, owner: string) {
  const row = byOwnerStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.vm_provider_configs, row, "vm_provider_configs");
}

const saveKeyStatement = statement(
  "INSERT INTO vm_provider_configs(owner_id,provider,encrypted_api_key,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET provider=excluded.provider,encrypted_api_key=excluded.encrypted_api_key,updated_at=excluded.updated_at",
);
/** Stores the sealed key, keeping the resources already found for the owner. */
export function saveKey(
  db: Database.Database,
  owner: string,
  provider: string,
  sealedKey: string,
  now: number,
) {
  saveKeyStatement(db).run(owner, provider, sealedKey, now);
}

const setResourcesStatement = statement(
  "UPDATE vm_provider_configs SET app_id=?,auth_volume_id=?,base_image_ref=?,base_image_version=?,updated_at=? WHERE owner_id=?",
);
export function setResources(
  db: Database.Database,
  owner: string,
  resources: {
    appId: string | null;
    authVolumeId: string | null;
    baseImageRef: string | null;
    baseImageVersion: string | null;
  },
  now: number,
) {
  return setResourcesStatement(db).run(
    resources.appId,
    resources.authVolumeId,
    resources.baseImageRef,
    resources.baseImageVersion,
    now,
    owner,
  ).changes;
}

const setDefaultHarnessStatement = statement(
  "UPDATE vm_provider_configs SET default_harness=?,updated_at=? WHERE owner_id=?",
);
export function setDefaultHarness(
  db: Database.Database,
  owner: string,
  harness: string | null,
  now: number,
) {
  return setDefaultHarnessStatement(db).run(harness, now, owner).changes;
}

const removeStatement = statement(
  "DELETE FROM vm_provider_configs WHERE owner_id=?",
);
export function remove(db: Database.Database, owner: string) {
  return removeStatement(db).run(owner).changes;
}
